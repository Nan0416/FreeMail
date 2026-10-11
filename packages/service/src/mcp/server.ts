/**
 * The agent-facing MCP server and its tools. Every tool is a THIN wrapper over a
 * shared service — `send_email` over #6's {@link EmailService}, and (#13) the read
 * tools `list_emails` / `get_email` / `get_email_attachment_url` over #11's
 * {@link EmailReadService}. All list/query/materialize/presign semantics live in those
 * services, so REST and MCP share one implementation; nothing is re-implemented here.
 *
 * What each tool SAYS — its description, schemas, and annotations, and the server's
 * instructions — lives in `tool-definitions.ts`; this file registers those and implements the
 * callbacks. `list_emails` defaulting is the same {@link parseListEmailsQuery} the REST route
 * uses; its input schema rejects out-of-range values before that (see list-query.ts).
 *
 * The read tools are registered ONLY when inbound is enabled (see {@link buildMcpServer}),
 * since the feature is "agents read inbound mail"; with inbound off, only `send_email`
 * is advertised.
 *
 * Untrusted content: inbound email is attacker-controlled. Both channels demarcate it —
 * `structuredContent` carries an explicit `trust` discriminator (declared in each tool's
 * `outputSchema`), and `content[].text` wraps inbound content in a nonce-delimited frame.
 * See {@link ../email/untrusted-frame}.
 */
import type {
  EmailDetail,
  EmailListItem,
  ListEmailsResponse,
  SendEmailRequest,
} from '@freemail/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { EmailError } from '../utils/errors.js';
import { parseListEmailsQuery, type RawListEmailsInput } from '../utils/list-query.js';
import type { EmailReadService } from '../services/email-read-service.js';
import type { AttachmentUploader } from '../services/attachment-service.js';
import type { EmailService } from '../services/email-service.js';
import { detailTrust, frameUntrusted, listTrust } from '../utils/untrusted-frame.js';
import {
  createAttachmentUploadTool,
  getEmailAttachmentUrlTool,
  getEmailTool,
  listEmailsTool,
  sendEmailTool,
  serverInstructions,
  type McpDeploymentInfo,
} from './tool-definitions.js';

export const MCP_SERVER_NAME = 'freemail';
export const MCP_SERVER_VERSION = '0.1.0';

/** Dependencies for {@link buildMcpServer}. Read tools register only when inbound is enabled. */
export interface McpServerDeps {
  readonly emailService: EmailService;
  /** Backs `create_attachment_upload` — registered whenever `send_email` is. */
  readonly attachmentService: AttachmentUploader;
  /** Present + `inboundEnabled` → the read tools are registered over this service. */
  readonly readService?: EmailReadService | undefined;
  /** Gate: the read tools are advertised only when inbound is enabled. Fail-closed. */
  readonly inboundEnabled: boolean;
  /** The sender domain and attachment limits the tool descriptions state. */
  readonly deployment: McpDeploymentInfo;
  /** Per-response nonce for the untrusted-content text boundary; injectable for tests. */
  readonly nonce?: (() => string) | undefined;
}

/**
 * Map a caught error to an MCP tool-error RESULT (`isError: true`), never a thrown
 * protocol error — so the agent gets a correctable signal instead of a 500. A known
 * {@link EmailError} surfaces its code + message; anything else is logged with context
 * server-side and returned as a generic message (no internals leaked).
 */
function toolErrorResult(error: unknown, genericMessage: string, logLabel: string): CallToolResult {
  if (error instanceof EmailError) {
    return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }] };
  }
  console.error(logLabel, error);
  return { isError: true, content: [{ type: 'text', text: genericMessage }] };
}

/** `create_attachment_upload`: a presigned PUT for one attachment ({@link AttachmentUploader}). */
export async function handleCreateUpload(
  attachmentService: AttachmentUploader,
  args: { filename: string; contentType?: string | undefined; sizeBytes: number },
): Promise<CallToolResult> {
  try {
    const upload = await attachmentService.createAttachmentUpload({
      filename: args.filename,
      ...(args.contentType !== undefined ? { contentType: args.contentType } : {}),
      sizeBytes: args.sizeBytes,
    });
    return {
      content: [
        {
          type: 'text',
          text:
            `Upload ${upload.uploadId} created. PUT exactly ${args.sizeBytes} bytes of the file ` +
            `to uploadUrl (expires ${upload.expiresAt}), then pass { "uploadId": ` +
            `"${upload.uploadId}" } in send_email.attachments.`,
        },
      ],
      structuredContent: { ...upload },
    };
  } catch (error) {
    return toolErrorResult(
      error,
      'Failed to create the upload due to an internal error.',
      'create_attachment_upload tool: unexpected failure',
    );
  }
}

/**
 * The `send_email` tool body. Exported so the success/known-failure/unexpected-failure
 * branches are asserted without driving the MCP protocol.
 */
export async function handleSendEmail(
  emailService: EmailService,
  request: SendEmailRequest,
): Promise<CallToolResult> {
  try {
    const result = await emailService.sendEmail(request);
    return {
      content: [
        {
          type: 'text',
          text:
            `Sent email ${result.id} (SES message ${result.messageId}) at ${result.sentAt}.` +
            (result.threaded === false
              ? ' It is NOT threaded: the original has no usable Message-ID, so it starts a new ' +
                'conversation.'
              : ''),
        },
      ],
      structuredContent: { ...result },
    };
  } catch (error) {
    return toolErrorResult(
      error,
      'Failed to send the email due to an internal error.',
      'send_email tool: unexpected failure sending email',
    );
  }
}

/** `list_emails`: the merged/direction-filtered timeline page over {@link EmailReadService}. */
export async function handleListEmails(
  readService: EmailReadService,
  nonce: () => string,
  args: RawListEmailsInput,
): Promise<CallToolResult> {
  try {
    const query = parseListEmailsQuery(args);
    const page = await readService.listEmails(query);
    return {
      content: [{ type: 'text', text: renderListText(page, nonce) }],
      structuredContent: {
        trust: listTrust(page.emails),
        emails: page.emails,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
    };
  } catch (error) {
    return toolErrorResult(
      error,
      'Failed to list emails due to an internal error.',
      'list_emails tool: unexpected failure listing emails',
    );
  }
}

/** `get_email`: one message (body materialized on demand for exposable inbound). */
export async function handleGetEmail(
  readService: EmailReadService,
  nonce: () => string,
  args: { id: string },
): Promise<CallToolResult> {
  try {
    const email = await readService.getEmail({ handle: args.id });
    return {
      content: [{ type: 'text', text: renderDetailText(email, nonce) }],
      structuredContent: { trust: detailTrust(email.direction), email },
    };
  } catch (error) {
    return toolErrorResult(
      error,
      'Failed to read the email due to an internal error.',
      'get_email tool: unexpected failure reading email',
    );
  }
}

/** `get_email_attachment_url`: a short-lived presigned download URL, verbatim from #11. */
export async function handleGetEmailAttachmentUrl(
  readService: EmailReadService,
  args: { id: string; attachmentId: string },
): Promise<CallToolResult> {
  try {
    const result = await readService.getAttachmentUrl({
      handle: args.id,
      attachmentId: args.attachmentId,
    });
    return {
      content: [
        {
          type: 'text',
          text: `Presigned download URL (expires ${result.expiresAt}). The attachment bytes are untrusted external content.`,
        },
      ],
      structuredContent: { ...result },
    };
  } catch (error) {
    return toolErrorResult(
      error,
      'Failed to mint the attachment URL due to an internal error.',
      'get_email_attachment_url tool: unexpected failure minting URL',
    );
  }
}

/** Human-readable text for a list page; inbound rows are wrapped in the untrusted frame. */
function renderListText(page: ListEmailsResponse, nonce: () => string): string {
  if (page.emails.length === 0) {
    // With a text filter, a page can examine its whole budget and match nothing while more
    // remains — so an empty page is only the end when there is no cursor.
    return page.nextCursor
      ? 'No matches in this stretch of the mailbox, but more remains to search — pass nextCursor.'
      : 'No emails.';
  }
  const header = `${page.emails.length} email(s)${page.nextCursor ? ' (more available — pass nextCursor)' : ''}.`;
  const rows = page.emails.map(listRow).join('\n');
  // If ANY row is inbound, frame the whole rendered list — over-marking own sent rows is safe.
  const body = page.emails.some((email) => email.direction === 'inbound')
    ? frameUntrusted(nonce(), rows)
    : rows;
  return `${header}\n${body}`;
}

function listRow(email: EmailListItem): string {
  const who =
    email.direction === 'inbound' ? `from ${email.from}` : `to ${email.to.join(', ') || '(none)'}`;
  let flags = '';
  if (email.direction === 'inbound' && email.failed) {
    flags = ' [failed: content not extracted]';
  } else if (email.direction === 'inbound' && email.quarantined) {
    flags = ' [quarantined]';
  } else if (email.direction === 'sent' && email.status && email.status !== 'sent') {
    // Surface a not-yet-delivered send (`sending`/`send_failed`) so a failed send is visible.
    flags = ` [${email.status}]`;
  }
  return `- [${email.direction}] ${email.date} ${who} — ${email.subject || '(no subject)'} (id: ${email.id})${flags}`;
}

/** Human-readable text for one message; inbound content is wrapped in the untrusted frame. */
function renderDetailText(email: EmailDetail, nonce: () => string): string {
  if (email.direction === 'sent') {
    // Own outgoing message — self-authored, so NOT wrapped in the untrusted frame.
    const lines = [`Sent email ${email.id}`];
    if (email.status) {
      lines.push(`Status: ${email.status}`);
    }
    lines.push(`To: ${email.to.join(', ') || '(none)'}`);
    if (email.cc.length) {
      lines.push(`Cc: ${email.cc.join(', ')}`);
    }
    if (email.replyTo?.length) {
      lines.push(`Reply-To: ${email.replyTo.join(', ')}`);
    }
    lines.push(`Subject: ${email.subject || '(no subject)'}`, `Date: ${email.date}`, '');
    if (email.text !== undefined) {
      lines.push(email.text);
    } else if (email.html !== undefined) {
      lines.push(
        `(HTML body — ${Buffer.byteLength(email.html, 'utf8')} bytes; raw HTML in structuredContent.email.html.)`,
      );
    } else {
      lines.push('(No stored body for this message.)');
    }
    if (email.bodyTruncated) {
      lines.push('', '(Body truncated at the read-size cap.)');
    }
    return lines.join('\n');
  }
  return frameUntrusted(nonce(), inboundDetailInner(email));
}

function inboundDetailInner(email: EmailDetail): string {
  const lines: string[] = [];
  if (email.quarantined) {
    lines.push('[QUARANTINED — hidden by default; a spam/virus verdict flagged this message.]');
  }
  lines.push(`From: ${email.fromName ? `${email.fromName} <${email.from}>` : email.from}`);
  lines.push(`To: ${email.to.join(', ') || '(none)'}`);
  if (email.cc.length) {
    lines.push(`Cc: ${email.cc.join(', ')}`);
  }
  if (email.replyTo?.length) {
    lines.push(`Reply-To: ${email.replyTo.join(', ')}`);
  }
  lines.push(`Subject: ${email.subject || '(no subject)'}`, `Date: ${email.date}`, '');
  if (email.text !== undefined) {
    lines.push(email.text);
  } else if (email.html !== undefined) {
    lines.push(
      `(HTML body — ${Buffer.byteLength(email.html, 'utf8')} bytes; raw HTML in structuredContent.email.html. Sandbox before rendering.)`,
    );
  } else {
    lines.push('(No readable body — content suppressed or not exposable.)');
  }
  if (email.bodyTruncated) {
    lines.push('', '(Body truncated at the read-size cap.)');
  }
  return lines.join('\n');
}

/**
 * Build a fresh MCP server. `send_email` and `create_attachment_upload` are always
 * registered; the read tools
 * (`list_emails`, `get_email`, `get_email_attachment_url`) are registered ONLY when
 * inbound is enabled AND a read service is supplied (fail-closed) — so with inbound
 * off, they never appear in `tools/list`.
 */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const readService = deps.inboundEnabled ? deps.readService : undefined;
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: serverInstructions(deps.deployment, readService !== undefined) },
  );
  server.registerTool(
    'send_email',
    sendEmailTool(deps.deployment, readService !== undefined),
    (args) => handleSendEmail(deps.emailService, args),
  );
  server.registerTool('create_attachment_upload', createAttachmentUploadTool(), (args) =>
    handleCreateUpload(deps.attachmentService, args),
  );

  if (readService) {
    const nonce = deps.nonce ?? (() => randomUUID());
    server.registerTool('list_emails', listEmailsTool(deps.deployment), (args) =>
      handleListEmails(readService, nonce, args),
    );
    server.registerTool('get_email', getEmailTool(), (args) =>
      handleGetEmail(readService, nonce, args),
    );
    server.registerTool('get_email_attachment_url', getEmailAttachmentUrlTool(), (args) =>
      handleGetEmailAttachmentUrl(readService, args),
    );
  }

  return server;
}
