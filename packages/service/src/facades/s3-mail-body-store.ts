/**
 * The S3 port for stored message bodies too large to keep inline in the emails row, plus its
 * S3 implementation. The ingest, send, and read paths depend on the interface so their logic
 * is testable with a fake; only this file touches `@aws-sdk/client-s3`.
 *
 * Each body is one JSON object (`{ text?, html?, truncated? }`) at a server-chosen key under
 * `bodies/`. It is written once and only ever read server-side — never presigned to a client.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** A decoded body as stored: already capped per part, so it is safe to load whole. */
export interface MailBodyContent {
  readonly text?: string;
  readonly html?: string;
  /** True when a part was cut to the per-part cap at storage time. */
  readonly truncated?: boolean;
}

export interface MailBodyStore {
  /** Store a body at a server-chosen `bodies/...` key. */
  putBody(key: string, body: MailBodyContent): Promise<void>;
  /** Load a stored body; null when the object does not exist. */
  getBody(key: string): Promise<MailBodyContent | null>;
}

const NO_SUCH_KEY = 'NoSuchKey';

export class S3MailBodyStore implements MailBodyStore {
  private readonly client: S3Client;

  constructor(
    client: S3Client,
    private readonly bucket: string,
  ) {
    this.client = client;
  }

  async putBody(key: string, body: MailBodyContent): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: 'application/json',
      }),
    );
  }

  async getBody(key: string): Promise<MailBodyContent | null> {
    let raw: string;
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) {
        return null;
      }
      raw = await out.Body.transformToString('utf-8');
    } catch (err) {
      if (err instanceof Error && err.name === NO_SUCH_KEY) {
        return null;
      }
      throw err;
    }
    return parseStoredBody(raw);
  }
}

/** Validate the JSON we wrote: keep only well-typed fields, so a corrupt object yields no body. */
export function parseStoredBody(raw: string): MailBodyContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(typeof record.html === 'string' ? { html: record.html } : {}),
    ...(record.truncated === true ? { truncated: true } : {}),
  };
}
