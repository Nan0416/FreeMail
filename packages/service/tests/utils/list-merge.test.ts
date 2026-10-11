import { describe, expect, it } from 'vitest';
import type { GetEmailOutput } from '../../src/data/emails-dao.js';
import { EmailError } from '../../src/utils/errors.js';
import {
  decodeListCursor,
  encodeListCursor,
  listEmailsPage,
  pageQuery,
  type MergeQuery,
  type MergeQueryResult,
} from '../../src/utils/list-merge.js';

/** Minimal row for a given direction + sort key (`<iso>#<id>`). */
function rowFor(direction: 'sent' | 'inbound', sk: string): GetEmailOutput {
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
  const partitions: Record<'sent' | 'inbound', GetEmailOutput[]> = {
    sent: sentSks.map((sk) => rowFor('sent', sk)).sort((a, b) => (a.sk < b.sk ? 1 : -1)),
    inbound: inboundSks.map((sk) => rowFor('inbound', sk)).sort((a, b) => (a.sk < b.sk ? 1 : -1)),
  };
  let calls = 0;
  const query: MergeQuery = pageQuery((direction, opts) => {
    calls++;
    const all = partitions[direction];
    let start = 0;
    // Local copy so the `!== undefined` narrowing survives into the findIndex callback.
    const afterSk = opts.afterSk;
    if (afterSk !== undefined) {
      const idx = all.findIndex((r) => r.sk < afterSk); // first strictly-older row
      start = idx === -1 ? all.length : idx;
    }
    return Promise.resolve(all.slice(start, start + opts.limit));
  });
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
): Promise<GetEmailOutput[]> {
  const out: GetEmailOutput[] = [];
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
    const store = makeStore(sent, inbound);

    const rows = await drainAll(store.query, { limit: 2 });
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
    const store = makeStore(sent, inbound);

    const rows = await drainAll(store.query, { limit: 3 });
    const order = rows.map((r) => r.sk);
    expect(order).toEqual(skDescending([...sent, ...inbound]));
    expect(new Set(order).size).toBe(12);
  });

  it('breaks timestamp ties deterministically by the #id suffix (no dupes)', async () => {
    const iso = '2026-07-17T10:00:00.000Z';
    const sent = [`${iso}#s2`, `${iso}#s0`];
    const inbound = [`${iso}#i1`, `${iso}#i3`];
    const store = makeStore(sent, inbound);

    const rows = await drainAll(store.query, { limit: 2 });
    const order = rows.map((r) => r.sk);
    // Total order = full-sk descending; ties resolved by id.
    expect(order).toEqual(skDescending([...sent, ...inbound]));
    expect(new Set(order).size).toBe(4);
  });

  it('drains correctly when one partition is empty', async () => {
    const sent = [`${T(3)}#s3`, `${T(1)}#s1`, `${T(0)}#s0`];
    const store = makeStore(sent, []);
    const rows = await drainAll(store.query, { limit: 2 });
    expect(rows.map((r) => r.sk)).toEqual(skDescending(sent));
    expect(rows.every((r) => r.direction === 'sent')).toBe(true);
  });

  it('returns nothing when both partitions are empty', async () => {
    const store = makeStore([], []);
    const page = await listEmailsPage({ query: store.query, limit: 5 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('filters to a single direction', async () => {
    const sent = [`${T(3)}#s3`, `${T(1)}#s1`];
    const inbound = [`${T(4)}#i4`, `${T(2)}#i2`];
    const store = makeStore(sent, inbound);

    const sentOnly = await drainAll(store.query, { direction: 'sent', limit: 1 });
    expect(sentOnly.map((r) => r.sk)).toEqual(skDescending(sent));
    expect(sentOnly.every((r) => r.direction === 'sent')).toBe(true);

    const inboundOnly = await drainAll(store.query, { direction: 'inbound', limit: 1 });
    expect(inboundOnly.map((r) => r.sk)).toEqual(skDescending(inbound));
  });

  it('ends cleanly on the exactly-limit boundary (no dupes across the phantom empty page)', async () => {
    const sent = [`${T(2)}#s2`, `${T(1)}#s1`];
    const inbound = [`${T(3)}#i3`, `${T(0)}#i0`];
    // Total 4 rows, limit 4 → first page returns all, but a partition that hit its fetch
    // limit reports "more"; the driver must terminate with the next (empty) page.
    const store = makeStore(sent, inbound);
    const rows = await drainAll(store.query, { limit: 4 });
    expect(rows.map((r) => r.sk)).toEqual(skDescending([...sent, ...inbound]));
    expect(new Set(rows.map((r) => r.sk)).size).toBe(4);
  });

  it('single page fits everything → no cursor', async () => {
    const store = makeStore([`${T(2)}#s2`], [`${T(1)}#i1`]);
    const page = await listEmailsPage({ query: store.query, limit: 10 });
    expect(page.rows.map((r) => r.sk)).toEqual([`${T(2)}#s2`, `${T(1)}#i1`]);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('listEmailsPage — the Errors folder', () => {
  it('pages through failed rows (inbound messages fetched as `failed`) to a real end', async () => {
    const all = ['f5', 'f4', 'f3', 'f2', 'f1'].map((id, i) => ({
      ...rowFor('inbound', `2026-07-17T0${9 - i}:00:00.000Z#${id}`),
      pk: 'FAILED',
    }));
    const query: MergeQuery = pageQuery((direction, opts) => {
      expect(direction).toBe('failed');
      const start = opts.afterSk ? all.findIndex((r) => r.sk === opts.afterSk) + 1 : 0;
      return Promise.resolve(all.slice(start, start + opts.limit));
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const page = await listEmailsPage({
        query,
        direction: 'failed',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      if (!cursor) {
        break;
      }
    }

    expect(seen).toEqual(['f5', 'f4', 'f3', 'f2', 'f1']); // each exactly once, then it ends
    expect(cursor).toBeUndefined();
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
    // The Errors folder keeps its own position.
    expect(decodeListCursor(encodeListCursor({ v: 1, failed: 'c#3' }))).toEqual({
      v: 1,
      failed: 'c#3',
    });
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

describe('listEmailsPage — filtered folders with a scan budget', () => {
  /**
   * A store whose query matches rows by a predicate and examines at most `budget` rows per call
   * — the shape of the read service's filtered scan.
   */
  function filteringStore(
    partitions: Record<'sent' | 'inbound', string[]>,
    matches: (sk: string) => boolean,
    budget: number,
  ): MergeQuery {
    const rows = {
      sent: skDescending(partitions.sent).map((sk) => rowFor('sent', sk)),
      inbound: skDescending(partitions.inbound).map((sk) => rowFor('inbound', sk)),
    };
    return (direction, opts): Promise<MergeQueryResult> => {
      const all = rows[direction as 'sent' | 'inbound'];
      const afterSk = opts.afterSk;
      const start = afterSk === undefined ? 0 : all.findIndex((r) => r.sk < afterSk);
      const from = start === -1 ? all.length : start;
      const found: GetEmailOutput[] = [];
      let scannedToSk: string | undefined;
      let index = from;
      for (; index < all.length && index < from + budget; index += 1) {
        scannedToSk = all[index].sk;
        if (matches(all[index].sk)) {
          found.push(all[index]);
          if (found.length === opts.limit) {
            return Promise.resolve({ rows: found, exhausted: false, scannedToSk });
          }
        }
      }
      return Promise.resolve({
        rows: found,
        exhausted: index >= all.length,
        ...(scannedToSk ? { scannedToSk } : {}),
      });
    };
  }

  const sks = (prefix: string, n: number, step: number, offset: number): string[] =>
    Array.from({ length: n }, (_v, i) => {
      const second = String(offset + i * step).padStart(4, '0');
      return `2026-07-17T10:00:00.${second.slice(-3)}Z#${prefix}${second}`;
    });

  it.each([
    { limit: 1, budget: 1 },
    { limit: 2, budget: 3 },
    { limit: 3, budget: 2 },
    { limit: 5, budget: 7 },
    { limit: 10, budget: 1000 },
  ])(
    'returns every match exactly once, newest first (limit $limit, budget $budget)',
    async (opts) => {
      const partitions = { sent: sks('s', 40, 3, 0), inbound: sks('i', 40, 3, 1) };
      // Sparse, uneven matches: a few sent rows, a run of inbound rows.
      const wanted = (sk: string) => /#s0(00[0-9]|09[0-9])$/.test(sk) || /#i00[3-6]\d$/.test(sk);
      const expected = skDescending([...partitions.sent, ...partitions.inbound]).filter(wanted);
      expect(expected.length).toBeGreaterThan(5);

      const rows = await drainAll(filteringStore(partitions, wanted, opts.budget), {
        limit: opts.limit,
      });

      expect(rows.map((r) => r.sk)).toEqual(expected);
    },
  );

  it('makes progress through pages with no matches at all, then ends', async () => {
    const partitions = { sent: sks('s', 30, 2, 0), inbound: sks('i', 30, 2, 1) };
    const pages: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const page = await listEmailsPage({
        query: filteringStore(partitions, () => false, 4),
        limit: 5,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page.rows.length);
      cursor = page.nextCursor;
      if (!cursor) {
        break;
      }
    }

    expect(cursor).toBeUndefined();
    expect(pages.every((n) => n === 0)).toBe(true);
    // 30 rows per folder, 4 examined per page: it ends after about 8 pages, not 100.
    expect(pages.length).toBeLessThanOrEqual(9);
  });

  it('holds back a match that may be out of order with a folder still mid-scan', async () => {
    // Inbound finds i8 at once, but sent has only examined s9 (10:00:09): an unexamined sent
    // row could be anywhere below that, including above i8 (10:00:08), so i8 must wait until
    // sent's scan has passed it.
    const partitions = {
      sent: ['2026-07-17T10:00:09.000Z#s9', '2026-07-17T10:00:07.000Z#s7'],
      inbound: ['2026-07-17T10:00:08.000Z#i8'],
    };
    const wanted = (sk: string) => sk.endsWith('#s7') || sk.endsWith('#i8');

    const first = await listEmailsPage({
      query: filteringStore(partitions, wanted, 1),
      limit: 5,
    });
    expect(first.rows).toEqual([]);
    expect(first.nextCursor).toBeDefined();

    const rows = await drainAll(filteringStore(partitions, wanted, 1), { limit: 5 });
    expect(rows.map((r) => r.id)).toEqual(['i8', 's7']);
  });
});
