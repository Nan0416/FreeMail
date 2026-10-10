/**
 * FreeMail deploy configuration — the single source of truth shared by the
 * `freemail init` CLI (which writes it) and the CDK app (which reads it at synth).
 *
 * The shape is a zod schema so the structural rules are declarative and read as one
 * piece; the cross-field rules that zod cannot express (every domain must sit inside
 * the hosted zone, app and api must differ, inbound needs its acknowledgement) are
 * `superRefine` checks below.
 *
 * `parseFreeMailConfig` is intentionally fail-loud: a malformed config is a deploy-time
 * footgun, so we reject it with a clear message rather than silently defaulting.
 */
import { z } from 'zod';
import { isSubdomainOrEqual, normalizeDomain } from './domain.js';

/** The only supported region — inbound SES + CloudFront ACM certs both require us-east-1. */
export const DEFAULT_REGION = 'us-east-1';

export type HostedZoneMode = 'import' | 'create';

export interface HostedZoneConfig {
  /** `import` an existing Route53 zone, or `create` a new one. */
  readonly mode: HostedZoneMode;
  /** The zone apex domain, e.g. `example.com`. */
  readonly zoneName: string;
  /** Required when `mode === 'import'`: the existing zone's ID. */
  readonly hostedZoneId?: string;
}

/** How the SES domain identity is managed. */
export type SesIdentityMode = 'create' | 'import';

export interface SesIdentityConfig {
  /**
   * `create` (default) — FreeMail creates the SES domain identity for `emailDomain` and
   * writes its DKIM / SPF / custom-MAIL-FROM / DMARC records into the hosted zone.
   *
   * `import` — the identity already exists and is verified, and you manage its auth
   * records yourself. FreeMail creates neither the identity nor any of those records, so
   * a domain that is already set up for SES does not collide on deploy.
   */
  readonly mode: SesIdentityMode;
}

export interface InboundConfig {
  /** Receive email (SES receipt → S3). Off by default. */
  readonly enabled: boolean;
  /**
   * Explicit acknowledgement of the MX override that enabling inbound performs.
   * Enabling inbound points the email domain's MX at SES; this must be `true`
   * before inbound can be enabled (enforced here and independently at synth).
   */
  readonly confirmInboundMx: boolean;
}

/**
 * When an outbound attachment is embedded in the message rather than sent as a download link.
 * Both optional — omitted, the defaults from `@freemail/shared` apply (3 MB / 10 MB).
 */
export interface AttachmentsConfig {
  /** Embed a file at most this many bytes (≤ 15 MB, so mail to your own domain isn't quarantined). */
  readonly embedMaxBytes?: number;
  /** Cap on one message's embedded files, in bytes (≤ 20 MB, well inside SES's 40 MB message). */
  readonly embedTotalBytes?: number;
}

export interface FreeMailConfig {
  /** AWS region. Pinned to us-east-1. */
  readonly region: string;
  readonly hostedZone: HostedZoneConfig;
  /** Domain email is sent from / received at — the zone apex or a subdomain of it. */
  readonly emailDomain: string;
  /**
   * Domain the web app is served at (CloudFront alias). REQUIRED (#47): the SPA calls
   * the API cross-origin, so this is the single canonical origin the API's credentialed
   * CORS allowlist is built from — there is no deployment shape without it.
   */
  readonly appDomain: string;
  /**
   * Domain the API is served at (API Gateway custom domain). REQUIRED (#47): the browser
   * and agents both reach the API here directly, and the session cookies are host-locked
   * to it.
   */
  readonly apiDomain: string;
  /** How the SES identity for `emailDomain` is managed. Omit for `create`. */
  readonly sesIdentity: SesIdentityConfig;
  readonly inbound: InboundConfig;
  /** Outbound attachment embed limits. Omit for the defaults. */
  readonly attachments?: AttachmentsConfig;
}

/** Canonicalized domain: trimmed, lowercased, trailing dot dropped, non-empty. */
const domainSchema = z
  .string({ error: 'is required and must be a domain name' })
  .transform(normalizeDomain)
  .refine((value) => value.length > 0, { error: 'must be a valid domain' });

const hostedZoneSchema = z
  .object({
    mode: z.enum(['import', 'create'], { error: 'must be "import" or "create"' }),
    zoneName: domainSchema,
    // Zone IDs are case-sensitive — trim only, never normalize.
    hostedZoneId: z.string().trim().min(1, { error: 'must be a non-empty string' }).optional(),
  })
  .superRefine((zone, ctx) => {
    if (zone.mode === 'import' && zone.hostedZoneId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['hostedZoneId'],
        message: '"hostedZone.hostedZoneId" is required when mode is "import".',
      });
    }
    if (zone.mode === 'create' && zone.hostedZoneId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['hostedZoneId'],
        message: '"hostedZone.hostedZoneId" is only valid when mode is "import".',
      });
    }
  });

const sesIdentitySchema = z
  .object({
    mode: z.enum(['create', 'import'], { error: 'must be "create" or "import"' }),
  })
  // Defaults to the original behavior, so a config written before this option existed
  // keeps deploying exactly as it did.
  .default({ mode: 'create' });

const inboundSchema = z.object({
  enabled: z.boolean({ error: 'must be a boolean' }),
  confirmInboundMx: z.boolean({ error: 'must be a boolean' }),
});

const MIB = 1024 * 1024;

/** A byte count from 1 to `maxMib` MiB. */
const byteLimit = (maxMib: number) =>
  z
    .number({ error: 'must be a number of bytes' })
    .int({ error: 'must be a whole number of bytes' })
    .min(1, { error: 'must be at least 1 byte' })
    .max(maxMib * MIB, { error: `must be at most ${maxMib} MB (${maxMib * MIB} bytes)` });

const attachmentsSchema = z
  .object({
    // ≤ the inbound per-attachment cap, so a message sent to your own domain isn't quarantined.
    embedMaxBytes: byteLimit(15).optional(),
    // base64 inflates ~1.37×, so 20 MB embedded stays well inside SES's 40 MB message.
    embedTotalBytes: byteLimit(20).optional(),
  })
  .optional();

const freeMailConfigSchema = z
  .object({
    // The only supported region: inbound SES and CloudFront ACM certs both require it.
    region: z
      .literal(DEFAULT_REGION, {
        error: `must be ${DEFAULT_REGION} (the only supported region)`,
      })
      .default(DEFAULT_REGION),
    hostedZone: hostedZoneSchema,
    emailDomain: domainSchema,
    appDomain: domainSchema,
    apiDomain: domainSchema,
    sesIdentity: sesIdentitySchema,
    inbound: inboundSchema,
    attachments: attachmentsSchema,
  })
  .superRefine((config, ctx) => {
    // Every managed domain's ACM validation and alias records are written into the one
    // hosted zone, so a domain outside it would silently fail to validate or resolve.
    for (const field of ['emailDomain', 'appDomain', 'apiDomain'] as const) {
      if (!isSubdomainOrEqual(config[field], config.hostedZone.zoneName)) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `"${field}" (${config[field]}) must equal or be a subdomain of the hosted zone (${config.hostedZone.zoneName}).`,
        });
      }
    }

    // One host cannot alias both CloudFront and API Gateway — the records would collide
    // — and it would collapse the cross-origin boundary the #47 CORS model rests on.
    if (config.appDomain === config.apiDomain) {
      ctx.addIssue({
        code: 'custom',
        path: ['apiDomain'],
        message: `"appDomain" and "apiDomain" must be different domains (both are "${config.appDomain}").`,
      });
    }

    // Enabling inbound repoints the email domain's MX at SES, clobbering existing mail
    // routing — it requires an explicit acknowledgement, captured by `freemail init`.
    if (config.inbound.enabled && !config.inbound.confirmInboundMx) {
      ctx.addIssue({
        code: 'custom',
        path: ['inbound', 'confirmInboundMx'],
        message:
          '"inbound.confirmInboundMx" must be true when inbound is enabled — ' +
          'acknowledge the MX override before enabling inbound.',
      });
    }
  });

/**
 * Render zod issues as one `FreeMail config:` message. Unlike the hand-rolled parser this
 * replaced, every problem is reported at once rather than only the first — so fixing a
 * config is one pass, not a guess-and-retry loop.
 */
function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.join('.');
    const message = issue.message.replace(/\.$/, '');
    // Messages that already name their field read better without a path prefix.
    return path.length > 0 && !issue.message.startsWith('"') ? `"${path}" ${message}` : message;
  });
  if (lines.length === 1) {
    return `FreeMail config: ${lines[0]}.`;
  }
  return `FreeMail config: ${lines.length} problems:\n${lines.map((line) => `  - ${line}`).join('\n')}`;
}

/**
 * Validate and normalize an unknown value into a {@link FreeMailConfig}, throwing on
 * any structural or semantic problem. Domains are canonicalized; `region` defaults to
 * (and must equal) us-east-1.
 */
export function parseFreeMailConfig(input: unknown): FreeMailConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('FreeMail config: expected a JSON object.');
  }

  const result = freeMailConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatIssues(result.error));
  }

  return {
    region: result.data.region,
    hostedZone: {
      mode: result.data.hostedZone.mode,
      zoneName: result.data.hostedZone.zoneName,
      ...(result.data.hostedZone.hostedZoneId
        ? { hostedZoneId: result.data.hostedZone.hostedZoneId }
        : {}),
    },
    emailDomain: result.data.emailDomain,
    appDomain: result.data.appDomain,
    apiDomain: result.data.apiDomain,
    sesIdentity: { mode: result.data.sesIdentity.mode },
    inbound: {
      enabled: result.data.inbound.enabled,
      confirmInboundMx: result.data.inbound.confirmInboundMx,
    },
    ...(result.data.attachments !== undefined
      ? {
          attachments: {
            ...(result.data.attachments.embedMaxBytes !== undefined
              ? { embedMaxBytes: result.data.attachments.embedMaxBytes }
              : {}),
            ...(result.data.attachments.embedTotalBytes !== undefined
              ? { embedTotalBytes: result.data.attachments.embedTotalBytes }
              : {}),
          },
        }
      : {}),
  };
}
