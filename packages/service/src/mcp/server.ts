/**
 * The agent-facing MCP server and its single `send_email` tool. The tool is a THIN
 * wrapper over the shared {@link EmailService} from #6 — it maps the tool arguments
 * onto the same `SendEmailRequest` wire contract and calls `send()`. All semantics
 * (sender-domain check, "at least one recipient / one body", caps, MIME assembly,
 * SES, and the metadata write) live in `EmailService`, so REST and MCP share one
 * validator. Nothing is re-implemented here.
 *
 * The Zod input schema is deliberately TYPE-ONLY (`from` required; everything else
 * a typed optional). Encoding the cross-field business rules here too would be the
 * seam violation to avoid — they belong to `EmailService`. Field descriptions carry
 * the human-readable rules so an agent can self-correct.
 */
import type { SendEmailRequest } from '@freemail/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { EmailError } from '../email/errors.js';
import type { EmailService } from '../email/service.js';

export const MCP_SERVER_NAME = 'freemail';
export const MCP_SERVER_VERSION = '0.1.0';

const sendEmailInputSchema = {
  from: z
    .string()
    .describe(
      "Sender address. Must be an address under this deployment's configured email domain.",
    ),
  fromName: z
    .string()
    .optional()
    .describe('Optional display name for the sender (rendered as "Name <addr>").'),
  to: z
    .array(z.string())
    .optional()
    .describe('Primary recipients. At least one recipient across to/cc/bcc is required.'),
  cc: z.array(z.string()).optional().describe('Carbon-copy recipients.'),
  bcc: z.array(z.string()).optional().describe('Blind carbon-copy recipients.'),
  subject: z.string().optional().describe('Subject line.'),
  text: z
    .string()
    .optional()
    .describe('Plain-text body. At least one of text or html is required.'),
  html: z.string().optional().describe('HTML body. At least one of text or html is required.'),
  attachments: z
    .array(
      z.object({
        filename: z.string().describe('File name shown to the recipient.'),
        contentType: z.string().describe('MIME content type, e.g. application/pdf.'),
        contentBase64: z.string().describe('Attachment bytes, base64-encoded.'),
      }),
    )
    .optional()
    .describe('Small attachments, embedded in the message.'),
};

const sendEmailOutputSchema = {
  id: z.string().describe("FreeMail's own id for the sent message."),
  messageId: z.string().describe('The message id SES assigned.'),
  sentAt: z.string().describe('Send time, ISO-8601.'),
};

/**
 * The `send_email` tool body. Exported so it can be unit-tested directly, and so
 * the success/known-failure/unexpected-failure branches are asserted without
 * driving the MCP protocol.
 *
 * Every failure is returned as an MCP tool-error RESULT (`isError: true`), never a
 * thrown protocol error — so the agent gets a correctable signal instead of a 500.
 * A known {@link EmailError} surfaces its code + message; anything else is logged
 * with context server-side and returned as a generic message (no internals leaked).
 */
export async function handleSendEmail(
  emailService: EmailService,
  request: SendEmailRequest,
): Promise<CallToolResult> {
  try {
    const result = await emailService.send(request);
    return {
      content: [
        {
          type: 'text',
          text: `Sent email ${result.id} (SES message ${result.messageId}) at ${result.sentAt}.`,
        },
      ],
      structuredContent: { ...result },
    };
  } catch (error) {
    if (error instanceof EmailError) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
      };
    }
    console.error('send_email tool: unexpected failure sending email', error);
    return {
      isError: true,
      content: [{ type: 'text', text: 'Failed to send the email due to an internal error.' }],
    };
  }
}

/** Build a fresh MCP server exposing `send_email` over the injected {@link EmailService}. */
export function buildMcpServer(emailService: EmailService): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  server.registerTool(
    'send_email',
    {
      title: 'Send email',
      description:
        "Send an email from an address under this deployment's configured domain. Requires at least one recipient (to/cc/bcc) and at least one body (text or html).",
      inputSchema: sendEmailInputSchema,
      outputSchema: sendEmailOutputSchema,
    },
    (args) => handleSendEmail(emailService, args),
  );
  return server;
}
