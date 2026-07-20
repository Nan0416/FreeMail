import { describe, expect, it } from 'vitest';
import type { StoredEmailRow } from '../../src/data/emails-repo.js';
import { EmailError } from '../../src/email/errors.js';
import {
  decodeListCursor,
  encodeListCursor,
  listEmailsPage,
  type MergeQuery,
} from '../../src/email/list-merge.js';

/** Minimal row for a given direction + sort key (`<iso>#<id>`). */
function rowFor(direction: 'sent' | 'inbound', sk: string): StoredEmailRow {
  const [iso, id] = sk.split('#');
  if (direction === 'sent') {
    return {
      direction: 'sent',
      sk,
      id,
      from: 'me@x.com',
      to: ['a@b.com'],
      cc: [],
      bcc: [],
      subject: `sent ${id}`,
      sesMessageId: id,
      sentAt: iso,
      attachmentCount: 0,
      sizeBytes: 0,
    };
  }
  return {
    direction: 'inbound',
    sk,
    id,
    sesMessageId: id,
    from: 'them@x.com',
    to: ['me@mydomain.com'],
    cc: [],
    subject: `inbound ${id}`,
    receivedAt: iso,
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    parseStatus: 'ok',
    quarantined: false,
    rawS3Key: `inbound/${id}`,
    sizeBytes: 0,
  };
}

/** A DDB-like partitioned store: each `query` returns rows strictly OLDER than `afterSk`, desc. */
function makeStore(
  sentSks: string[],
  inboundSks: string[],
): {
  query: MergeQuery;
  calls: number;
} {
  const partitions: Record<'sent' | 'inbound', StoredEmailRow[]> = {
    sent: sentSks.map((sk) => rowFor('sent', sk)).sort((a, b) => (a.sk < b.sk ? 1 : -1)),
    inbound: inboundSks.map((sk) => rowFor('inbound', sk)).sort((a, b) => (a.sk < b.sk ? 1 : -1)),
  };
  let calls = 0;
  const query: MergeQuery = (direction, { limit, afterSk }) => {
    calls++;
    const all = partitions[direction];
    let start = 0;
    if (afterSk !== undefined) {
      const idx = all.findIndex((r) => r.sk < afterSk); // first strictly-older row
      start = idx === -1 ? all.length : idx;
    }
    return Promise.resolve(all.slice(start, start + limit));
  };
  return {
    get calls() {
      return calls;
    },
    query,
  };
}

/** Drain every page and return the flat row list, guarding against a runaway loop. */
async function drainAll(
  query: MergeQuery,
  opts: { direction?: 'sent' | 'inbound'; limit: number },
): Promise<StoredEmailRow[]> {
  const out: StoredEmailRow[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const page = await listEmailsPage({
      query,
      ...(opts.direction ? { direction: opts.direction } : {}),
      limit: opts.limit,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.rows);
    if (!page.nextCursor) {
      return out;
    }
    cursor = page.nextCursor;
  }
  throw new Error('drainAll did not terminate — pagination likely loops');
}

function skDescending(sks: string[]): string[] {
  return [...sks].sort((a, b) => (a < b ? 1 : -1));
}

const T = (n: number) => `2026-07-17T10:00:0${n}.000Z`;

describe('listEmailsPage — merge + cursor', () => {
  it('merges two partitions newest-first with no dupes or drops (interleaved, across page boundary)', async () => {
    const sent = [`${T(3)}#s3`, `${T(1)}#s1`];
    const inbound = [`${T(4)}#i4`, `${T(2)}#i2`, `${T(0)}#i0`];
    const { query } = makeStore(sent, inbound);

    const rows = await drainAll(query, { limit: 2 });
    const order = rows.map((r) => r.sk);
    // Strict interleaved global order, newest-first.
    expect(order).toEqual([`${T(4)}#i4`, `${T(3)}#s3`, `${T(2)}#i2`, `${T(1)}#s1`, `${T(0)}#i0`]);
    // Completeness: every row exactly once.
    expect(new Set(order).size).toBe(5);
    expect(order.length).toBe(5);
  });

  it('handles one partition dominating the timeline', async () => {
    const sent = Array.from({ length: 10 }, (_, i) => `${T(9 - i)}#s${9 - i}`);
    const inbound = [`2026-07-17T09:59:00.000Z#iA`, `2026-07-17T08:00:00.000Z#iB`];
    const { query } = makeStore(sent, inbound);

    const rows = await drainAll(query, { limit: 3 });
    const order = rows.map((r) => r.sk);
    expect(order).toEqual(skDescending([...sent, ...inbound]));
    expect(new Set(order).size).toBe(12);
  });

  it('breaks timestamp ties deterministically by the #id suffix (no dupes)', async () => {
    const iso = '2026-07-17T10:00:00.000Z';
    const sent = [`${iso}#s2`, `${iso}#s0`];
    const inbound = [`${iso}#i1`, `${iso}#i3`];
    const { query } = makeStore(sent, inbound);

    const rows = await drainAll(query, { limit: 2 });
    const order = rows.map((r) => r.sk);
    // Total order = full-sk descending; ties resolved by id.
    expect(order).toEqual(skDescending([...sent, ...inbound]));
    expect(new Set(order).size).toBe(4);
  });

  it('drains correctly when one partition is empty', async () => {
    const sent = [`${T(3)}#s3`, `${T(1)}#s1`, `${T(0)}#s0`];
    const { query } = makeStore(sent, []);
    const rows = await drainAll(query, { limit: 2 });
    expect(rows.map((r) => r.sk)).toEqual(skDescending(sent));
    expect(rows.every((r) => r.direction === 'sent')).toBe(true);
  });

  it('returns nothing when both partitions are empty', async () => {
    const { query } = makeStore([], []);
    const page = await listEmailsPage({ query, limit: 5 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('filters to a single direction', async () => {
    const sent = [`${T(3)}#s3`, `${T(1)}#s1`];
    const inbound = [`${T(4)}#i4`, `${T(2)}#i2`];
    const { query } = makeStore(sent, inbound);

    const sentOnly = await drainAll(query, { direction: 'sent', limit: 1 });
    expect(sentOnly.map((r) => r.sk)).toEqual(skDescending(sent));
    expect(sentOnly.every((r) => r.direction === 'sent')).toBe(true);

    const inboundOnly = await drainAll(query, { direction: 'inbound', limit: 1 });
    expect(inboundOnly.map((r) => r.sk)).toEqual(skDescending(inbound));
  });

  it('ends cleanly on the exactly-limit boundary (no dupes across the phantom empty page)', async () => {
    const sent = [`${T(2)}#s2`, `${T(1)}#s1`];
    const inbound = [`${T(3)}#i3`, `${T(0)}#i0`];
    // Total 4 rows, limit 4 → first page returns all, but a partition that hit its fetch
    // limit reports "more"; the driver must terminate with the next (empty) page.
    const { query } = makeStore(sent, inbound);
    const rows = await drainAll(query, { limit: 4 });
    expect(rows.map((r) => r.sk)).toEqual(skDescending([...sent, ...inbound]));
    expect(new Set(rows.map((r) => r.sk)).size).toBe(4);
  });

  it('single page fits everything → no cursor', async () => {
    const { query } = makeStore([`${T(2)}#s2`], [`${T(1)}#i1`]);
    const page = await listEmailsPage({ query, limit: 10 });
    expect(page.rows.map((r) => r.sk)).toEqual([`${T(2)}#s2`, `${T(1)}#i1`]);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('list cursor codec', () => {
  it('round-trips', () => {
    const token = encodeListCursor({ v: 1, sent: 'a#1', inbound: 'b#2' });
    expect(decodeListCursor(token)).toEqual({ v: 1, sent: 'a#1', inbound: 'b#2' });
  });

  it('round-trips a partial (single-direction) cursor', () => {
    const token = encodeListCursor({ v: 1, sent: 'a#1' });
    expect(decodeListCursor(token)).toEqual({ v: 1, sent: 'a#1' });
  });

  it('rejects a malformed / wrong-version / wrong-type cursor with a 400', () => {
    const bad = [
      '!!not base64!!',
      Buffer.from('not json', 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify(['array']), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 2, sent: 'a#1' }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, sent: 42 }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, inbound: '' }), 'utf8').toString('base64url'),
    ];
    for (const token of bad) {
      try {
        decodeListCursor(token);
        throw new Error(`expected reject for ${token}`);
      } catch (err) {
        expect(err).toBeInstanceOf(EmailError);
        expect((err as EmailError).status).toBe(400);
      }
    }
  });
});
