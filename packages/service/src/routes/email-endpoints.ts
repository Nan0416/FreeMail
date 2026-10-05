/**
 * The mailbox surface: one send route and four read routes.
 *
 * The two halves have deliberately DIFFERENT authorization:
 *  - `POST /emails` is dual-scheme. A Bearer human and an `x-api-key` agent may both send,
 *    so there is NO `requireAccessScheme` — sending is the capability an agent key is for.
 *  - the reads are access-token only. The agent read path is the MCP `list_emails` /
 *    `get_email` / `get_email_attachment_url` tools over the same read service, not these
 *    routes, so an agent key must not reach the REST mailbox.
 *
 * Request coercion here is types-only. The semantic rules — sender domain, recipient
 * presence, size caps — live in `EmailService`, and list defaulting/clamping lives in
 * `parseListEmailsQuery`, so REST and MCP can never drift apart.
 */
import type { EmailAttachment, SendEmailRequest } from '@freemail/shared';
import { Router } from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { emailErrors } from '../utils/errors.js';
import { parseListEmailsQuery } from '../utils/list-query.js';
import type { EmailReadService, ListEmailsServiceRequest } from '../services/email-read-service.js';
import type { EmailService } from '../services/email-service.js';
import { requireAccessScheme } from '../middleware/auth-middleware.js';
import { requireJsonContentType } from '../middleware/json-content-type.js';
import { getLogger } from '../utils/logger.js';
import {
  optionalString,
  requireBody,
  requirePathParam,
  requireString,
} from '../utils/request-validation.js';
import type { Endpoints } from './endpoints.js';

const logger = getLogger('EmailEndpoints');

export class EmailEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(emailService: EmailService, readService: EmailReadService) {
    this.router = Router();

    // Dual-scheme by design: NO requireAccessScheme here.
    this.router.post(
      '/emails',
      requireJsonContentType,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const request = parseSendEmailBody(requireBody(req));
          logger.info('POST /emails.');
          res.status(200).json(await emailService.send(request));
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.get(
      '/emails',
      requireAccessScheme,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const query = parseListQuery(req);
          logger.info('GET /emails.');
          res.status(200).json(await readService.listEmails(query));
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.get(
      '/emails/:id',
      requireAccessScheme,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          logger.info('GET /emails/:id.');
          res.status(200).json(await readService.getEmail({ handle: requirePathParam(req, 'id') }));
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.get(
      '/emails/:id/attachments/:attachmentId',
      requireAccessScheme,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          logger.info('GET /emails/:id/attachments/:attachmentId.');
          const url = await readService.getAttachmentUrl({
            handle: requirePathParam(req, 'id'),
            attachmentId: requirePathParam(req, 'attachmentId'),
          });
          res.status(200).json(url);
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.get(
      '/emails/:id/raw',
      requireAccessScheme,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          logger.info('GET /emails/:id/raw.');
          res
            .status(200)
            .json(await readService.getRawUrl({ handle: requirePathParam(req, 'id') }));
        } catch (err) {
          next(err);
        }
      },
    );
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}

/**
 * Parse `GET /emails` query params via the shared {@link parseListEmailsQuery} — the same
 * validation/defaulting/clamping the MCP `list_emails` tool uses.
 *
 * Express parses a query string into `string | string[] | ParsedQs`, so a repeated
 * parameter (`?limit=1&limit=2`) arrives as an array. Anything that is not a plain string
 * is dropped to undefined rather than coerced, so a repeated parameter is treated as
 * absent instead of silently stringifying to `"1,2"`.
 */
function parseListQuery(req: Request): ListEmailsServiceRequest {
  return parseListEmailsQuery({
    direction: singleQueryValue(req, 'direction'),
    limit: singleQueryValue(req, 'limit'),
    cursor: singleQueryValue(req, 'cursor'),
  });
}

function singleQueryValue(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Coerce untrusted JSON into a {@link SendEmailRequest} shape (types only). Optional
 * fields are omitted rather than set to `undefined` so the service sees exactly the keys
 * the caller sent.
 */
function parseSendEmailBody(body: Record<string, unknown>): SendEmailRequest {
  // `from` is validated first so a missing sender is reported before any other field error.
  const from = requireString(body, 'from');
  const fromName = optionalString(body, 'fromName');
  const subject = optionalString(body, 'subject');
  const text = optionalString(body, 'text');
  const html = optionalString(body, 'html');
  const to = optionalStringArray(body, 'to');
  const cc = optionalStringArray(body, 'cc');
  const bcc = optionalStringArray(body, 'bcc');
  const attachments = optionalAttachments(body);
  return {
    from,
    ...(fromName !== undefined ? { fromName } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cc !== undefined ? { cc } : {}),
    ...(bcc !== undefined ? { bcc } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw emailErrors.invalidRequest(`"${field}" must be an array of strings.`);
  }
  return value as string[];
}

function optionalAttachments(body: Record<string, unknown>): EmailAttachment[] | undefined {
  const value = body.attachments;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw emailErrors.invalidRequest('"attachments" must be an array.');
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw emailErrors.invalidRequest(`"attachments[${index}]" must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const { filename, contentType, contentBase64 } = record;
    if (
      typeof filename !== 'string' ||
      typeof contentType !== 'string' ||
      typeof contentBase64 !== 'string'
    ) {
      throw emailErrors.invalidRequest(
        `"attachments[${index}]" must have string filename, contentType, and contentBase64.`,
      );
    }
    return { filename, contentType, contentBase64 };
  });
}
