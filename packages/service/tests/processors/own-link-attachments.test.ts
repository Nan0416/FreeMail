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
  type ResolveLinkedAttachmentsRequest,
} from '../../src/processors/own-link-attachments.js';

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

/** A request for a message from me@example.com that passed SES's DMARC check. */
function request(
  bodies: readonly (string | undefined)[],
  over: Partial<ResolveLinkedAttachmentsRequest> = {},
): ResolveLinkedAttachmentsRequest {
  return {
    bodies,
    from: 'me@example.com',
    authenticatedDomain: 'example.com',
    receivedAt: RECEIVED_AT,
    ...over,
  };
}

async function attachedKeys(
  links: OwnLinkAttachments,
  req: ResolveLinkedAttachmentsRequest,
): Promise<string[]> {
  return (await links.resolveLinkedAttachments(req)).attachments.map((a) => a.s3Key);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OwnLinkAttachments.resolve', () => {
  it('attaches each file your own send linked, pointing at its permanent sent copy', async () => {
    const tokens = new FakeTokens().add(record(0), record(1));
    const links = new OwnLinkAttachments(tokens, BASE);

    const resolved = await links.resolveLinkedAttachments(
      request([`Files:\n- ${link(0)}\n- ${link(1)}`, `<a href="${link(0)}">file-0.pdf</a>`], {
        from: 'Me@Example.com',
      }),
    );

    expect(resolved.attachments).toEqual([
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
    ['expiring the instant the message arrived', record(0, { expiresAt: RECEIVED_AT })],
    ['sent to no address of yours', record(0, { ownDomainRecipients: undefined })],
    ['sent to an empty list of your addresses', record(0, { ownDomainRecipients: [] })],
    ['minted before tokens kept their sender', record(0, { sender: undefined })],
    ['pointing at raw inbound mail', record(0, { s3Key: 'inbound/abc' })],
    ['pointing at a received attachment', record(0, { s3Key: 'attachments/inbound/abc/0' })],
    ['pointing at a legacy linked upload', record(0, { s3Key: 'attachments/outbound/e1/0' })],
  ])('leaves a link as just a link when its token is %s', async (_label, stored) => {
    const links = new OwnLinkAttachments(new FakeTokens().add(stored), BASE);
    expect(await attachedKeys(links, request([link(0)]))).toEqual([]);
  });

  it.each([
    ['SES reported no DMARC pass', { authenticatedDomain: undefined }],
    ['DMARC passed for another domain', { authenticatedDomain: 'evil.example' }],
  ])('looks nothing up when %s (the From could be spoofed)', async (_label, over) => {
    const tokens = new FakeTokens().add(record(0));
    const links = new OwnLinkAttachments(tokens, BASE);
    expect(await attachedKeys(links, request([link(0)], over))).toEqual([]);
    expect(tokens.lookups).toEqual([]);
  });

  it('skips a link whose token is unknown, and one whose lookup fails (best-effort)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tokens = new FakeTokens().add(record(2));
    tokens.failToken = token(1);
    const links = new OwnLinkAttachments(tokens, BASE);

    const resolved = await links.resolveLinkedAttachments(
      request([`${link(0)} ${link(1)} ${link(2)}`]),
    );

    expect(resolved.attachments.map((a) => a.s3Key)).toEqual(['attachments/sent/e1/2']);
    expect(resolved.attachments[0]?.id).toBe('link-0');
  });

  it('attaches a file once even when two of its tokens are linked', async () => {
    const tokens = new FakeTokens().add(record(0), record(1, { s3Key: 'attachments/sent/e1/0' }));
    const resolved = await new OwnLinkAttachments(tokens, BASE).resolveLinkedAttachments(
      request([`${link(0)} ${link(1)}`]),
    );
    expect(resolved.attachments).toHaveLength(1);
  });
});

describe('OwnLinkAttachments — which links are looked up', () => {
  it('only this deployment’s own, well-formed links', async () => {
    const tokens = new FakeTokens();
    const links = new OwnLinkAttachments(tokens, `${BASE}/`);
    await links.resolveLinkedAttachments(
      request([
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
    );
    expect(tokens.lookups).toEqual([token(0), token(1)]);
  });

  it('at most 20 per message', async () => {
    const tokens = new FakeTokens();
    const many = Array.from({ length: 30 }, (_, n) => link(n)).join(' ');
    await new OwnLinkAttachments(tokens, BASE).resolveLinkedAttachments(request([many]));
    expect(tokens.lookups).toHaveLength(MAX_LINKED_ATTACHMENTS);
    expect(MAX_LINKED_ATTACHMENTS).toBe(20);
  });
});
