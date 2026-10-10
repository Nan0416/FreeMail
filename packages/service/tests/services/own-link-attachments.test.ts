import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaimDownloadTokenOutput,
  CreateDownloadTokenOutput,
  DownloadTokensDao,
  GetDownloadTokenInput,
  GetDownloadTokenOutput,
} from '../../src/data/download-tokens-dao.js';
import {
  MAX_LINKED_ATTACHMENTS,
  OwnLinkAttachments,
} from '../../src/services/own-link-attachments.js';

const BASE = 'https://abc123.execute-api.us-east-1.amazonaws.com';
const RECEIVED_AT = '2026-10-10T00:00:00.000Z';

/** A well-formed (43-char base64url) token, distinct per n. */
function token(n: number): string {
  return `T${String(n).padStart(42, '0')}`;
}

function record(n: number, over: Partial<GetDownloadTokenOutput> = {}): GetDownloadTokenOutput {
  return {
    token: token(n),
    s3Key: `attachments/sent/e1/${n}`,
    filename: `file-${n}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 5_000_000 + n,
    emailId: 'e1',
    createdAt: '2026-10-09T23:59:00.000Z',
    expiresAt: '2026-11-08T23:59:00.000Z',
    ttl: 1_794_441_540,
    revoked: false,
    downloadCount: 0,
    sender: 'me@example.com',
    ownDomainRecipients: ['team@example.com'],
    ...over,
  };
}

class FakeTokens implements DownloadTokensDao {
  readonly records = new Map<string, GetDownloadTokenOutput>();
  readonly lookups: string[] = [];
  failToken?: string;
  add(...records: GetDownloadTokenOutput[]): this {
    for (const r of records) {
      this.records.set(r.token, r);
    }
    return this;
  }
  createDownloadToken(): Promise<CreateDownloadTokenOutput> {
    return Promise.resolve({});
  }
  claimDownloadToken(): Promise<ClaimDownloadTokenOutput | null> {
    throw new Error('inbound linking must never claim a token');
  }
  getDownloadToken(input: GetDownloadTokenInput): Promise<GetDownloadTokenOutput | null> {
    this.lookups.push(input.token);
    if (input.token === this.failToken) {
      return Promise.reject(new Error('ddb down'));
    }
    return Promise.resolve(this.records.get(input.token) ?? null);
  }
}

function link(n: number): string {
  return `${BASE}/d/${token(n)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OwnLinkAttachments.resolve', () => {
  it('attaches each file your own send linked, pointing at its permanent sent copy', async () => {
    const tokens = new FakeTokens().add(record(0), record(1));
    const links = new OwnLinkAttachments(tokens, BASE);

    const attached = await links.resolve({
      bodies: [`Files:\n- ${link(0)}\n- ${link(1)}`, `<a href="${link(0)}">file-0.pdf</a>`],
      from: 'Me@Example.com',
      receivedAt: RECEIVED_AT,
    });

    expect(attached).toEqual([
      {
        id: 'link-0',
        filename: 'file-0.pdf',
        contentType: 'application/pdf',
        sizeBytes: 5_000_000,
        s3Key: 'attachments/sent/e1/0',
      },
      {
        id: 'link-1',
        filename: 'file-1.pdf',
        contentType: 'application/pdf',
        sizeBytes: 5_000_001,
        s3Key: 'attachments/sent/e1/1',
      },
    ]);
    // Each distinct token is looked up once, even when the text and HTML both link it.
    expect(tokens.lookups).toEqual([token(0), token(1)]);
  });

  it.each([
    ['from someone else', record(0, { sender: 'other@example.com' })],
    ['revoked', record(0, { revoked: true })],
    ['expired before the message arrived', record(0, { expiresAt: '2026-10-09T00:00:00.000Z' })],
    ['sent to no address of yours', record(0, { ownDomainRecipients: undefined })],
    ['minted before tokens kept their sender', record(0, { sender: undefined })],
    ['pointing outside the sent attachments', record(0, { s3Key: 'inbound/abc' })],
  ])('leaves a link as just a link when its token is %s', async (_label, stored) => {
    const links = new OwnLinkAttachments(new FakeTokens().add(stored), BASE);
    const attached = await links.resolve({
      bodies: [link(0)],
      from: 'me@example.com',
      receivedAt: RECEIVED_AT,
    });
    expect(attached).toEqual([]);
  });

  it('skips a link whose token is unknown, and one whose lookup fails (best-effort)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tokens = new FakeTokens().add(record(2));
    tokens.failToken = token(1);
    const links = new OwnLinkAttachments(tokens, BASE);

    const attached = await links.resolve({
      bodies: [`${link(0)} ${link(1)} ${link(2)}`],
      from: 'me@example.com',
      receivedAt: RECEIVED_AT,
    });

    expect(attached.map((a) => a.s3Key)).toEqual(['attachments/sent/e1/2']);
    expect(attached[0]?.id).toBe('link-0');
  });

  it('attaches a file once even when two of its tokens are linked', async () => {
    const tokens = new FakeTokens().add(record(0), record(1, { s3Key: 'attachments/sent/e1/0' }));
    const attached = await new OwnLinkAttachments(tokens, BASE).resolve({
      bodies: [`${link(0)} ${link(1)}`],
      from: 'me@example.com',
      receivedAt: RECEIVED_AT,
    });
    expect(attached).toHaveLength(1);
  });
});

describe('OwnLinkAttachments.findTokens', () => {
  const links = new OwnLinkAttachments(new FakeTokens(), `${BASE}/`);

  it('finds only this deployment’s own, well-formed links', () => {
    expect(
      links.findTokens([
        [
          link(0),
          `${BASE.toUpperCase()}/d/${token(1)}`, // the host matches case-insensitively
          `https://evil.example/d/${token(2)}`, // someone else's host
          `${BASE}/d/short`, // not a token
          `${BASE}/d/${token(3)}extra`, // too long to be a token
          `${BASE}.evil.example/d/${token(4)}`, // the base must end where it ends
        ].join('\n'),
        undefined,
      ]),
    ).toEqual([token(0), token(1)]);
  });

  it('looks up at most 20 links per message', () => {
    const many = Array.from({ length: 30 }, (_, n) => link(n)).join(' ');
    expect(links.findTokens([many])).toHaveLength(MAX_LINKED_ATTACHMENTS);
    expect(MAX_LINKED_ATTACHMENTS).toBe(20);
  });
});
