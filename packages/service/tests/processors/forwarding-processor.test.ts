import { describe, expect, it } from 'vitest';
import type { CreateInboundEmailInput, EmailsDao, GetEmailInput, GetEmailOutput, UpdateInboundEmailForwardInput, UpdateInboundEmailForwardOutput } from '../../src/data/emails-dao.js';
import type { ForwardingRule } from '@freemail/shared';
import type { ForwardingRulesDao } from '../../src/data/forwarding-rules-dao.js';
import type { RawMessageReader } from '../../src/facades/s3-raw-message-reader.js';
import type { SendRawParams, SesSender } from '../../src/facades/ses-email-facade.js';
import { ForwardingProcessor } from '../../src/processors/forwarding-processor.js';
import { encodeEmailRef } from '../../src/utils/email-ref.js';
import { headerValues, parseHeaderLines, rootHeaderBlock } from '../../src/utils/inbound-headers.js';

const RECEIVED_AT = '2026-11-13T10:00:00.000Z';
const NOW = new Date('2026-11-13T10:00:07.000Z');

function rawMessage(extraHeaders: readonly string[] = [], dmarc = 'pass'): Buffer {
  return Buffer.from(
    [
      'X-SES-Spam-Verdict: PASS',
      'X-SES-Virus-Verdict: PASS',
      `Authentication-Results: amazonses.com; spf=pass smtp.mailfrom=customer.com; dkim=pass header.i=@customer.com; dmarc=${dmarc} header.from=customer.com;`,
      ...extraHeaders,
      'From: Alice <alice@customer.com>',
      'To: R123@returns.amazon.com',
      'Subject: Return R123',
      '',
      'Body',
      '',
    ].join('\r\n'),
  );
}

function row(overrides: Partial<CreateInboundEmailInput> = {}): GetEmailOutput {
  return {
    direction: 'inbound',
    pk: 'INBOUND',
    sk: `${RECEIVED_AT}#msg-1`,
    id: 'msg-1',
    sesMessageId: 'msg-1',
    from: 'alice@customer.com',
    fromName: 'Alice',
    to: ['R123@returns.amazon.com'],
    cc: [],
    subject: 'Return R123',
    receivedAt: RECEIVED_AT,
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    parseStatus: 'ok',
    quarantined: false,
    rawS3Key: 'inbound/msg-1',
    sizeBytes: 300,
    ...overrides,
  };
}

/** The notification the parser publishes for {@link row}'s defaults; fields overridable. */
function notification(fields: Record<string, unknown> = {}, pk = 'INBOUND'): string {
  return JSON.stringify({
    version: 1,
    type: 'email.received',
    id: encodeEmailRef({ pk, sk: `${RECEIVED_AT}#msg-1` }),
    receivedAt: RECEIVED_AT,
    from: 'alice@customer.com',
    fromName: 'Alice',
    to: ['R123@returns.amazon.com'],
    cc: [],
    subject: 'Return R123',
    spam: false,
    ...fields,
  });
}

/** A stored rule: enabled, DMARC-checked, matching nothing until overridden. */
function forwardingRule(overrides: Partial<ForwardingRule>): ForwardingRule {
  return {
    id: 'rule',
    name: 'Rule',
    enabled: true,
    senderDomains: [],
    senderAddresses: [],
    recipientDomains: [],
    recipientAddresses: [],
    forwardTo: [],
    ignoreDmarcVerification: false,
    createdAt: RECEIVED_AT,
    updatedAt: RECEIVED_AT,
    ...overrides,
  };
}

const AMAZON_RULE = forwardingRule({
  id: 'amazon-returns',
  recipientDomains: ['returns.amazon.com'],
  forwardTo: ['trex@example.com'],
});

const CUSTOMER_RULE = forwardingRule({
  id: 'customer',
  senderDomains: ['customer.com'],
  forwardTo: ['ops@example.org'],
});

/** The rules DAO, read-only: the processor only ever lists. */
function rulesDao(rules: readonly ForwardingRule[]): ForwardingRulesDao {
  return {
    listForwardingRules: () => Promise.resolve({ rules }),
  } as unknown as ForwardingRulesDao;
}

interface Harness {
  readonly processor: ForwardingProcessor;
  readonly gets: GetEmailInput[];
  readonly reads: string[];
  readonly sends: SendRawParams[];
  readonly forwards: UpdateInboundEmailForwardInput[];
}

function harness(
  options: {
    row?: GetEmailOutput | null;
    rules?: readonly ForwardingRule[];
    raw?: Buffer | null;
    sendFails?: boolean;
    /** SES's error, by name (`sendFails` throws a plain Error). */
    sendError?: string;
    recorded?: boolean;
  } = {},
): Harness {
  const gets: GetEmailInput[] = [];
  const reads: string[] = [];
  const sends: SendRawParams[] = [];
  const forwards: UpdateInboundEmailForwardInput[] = [];
  const emails = {
    getEmail(input: GetEmailInput): Promise<GetEmailOutput | null> {
      gets.push(input);
      return Promise.resolve(options.row === undefined ? row() : options.row);
    },
    updateInboundEmailForward(input: UpdateInboundEmailForwardInput): Promise<UpdateInboundEmailForwardOutput> {
      forwards.push(input);
      return Promise.resolve({ recorded: options.recorded ?? true });
    },
  } as unknown as EmailsDao;
  const rawMessages: RawMessageReader = {
    getRawMessage(key: string): Promise<Buffer | null> {
      reads.push(key);
      return Promise.resolve(options.raw === undefined ? rawMessage() : options.raw);
    },
  };
  const ses: SesSender = {
    send(params: SendRawParams): Promise<{ messageId: string }> {
      sends.push(params);
      if (options.sendError !== undefined) {
        const err = new Error(`SES says no (${options.sendError})`);
        err.name = options.sendError;
        return Promise.reject(err);
      }
      return options.sendFails ? Promise.reject(new Error('TooManyRequestsException')) : Promise.resolve({ messageId: 'ses-fwd-1' });
    },
  };
  const processor = new ForwardingProcessor({
    emails,
    rules: rulesDao(options.rules ?? [AMAZON_RULE]),
    rawMessages,
    ses,
    emailDomain: 'warehouse.example',
    now: () => NOW,
  });
  return { processor, gets, reads, sends, forwards };
}

describe('ForwardingProcessor — forwarding', () => {
  it('re-sends a matching message to the rule’s targets and records the forward', async () => {
    const h = harness();

    const result = await h.processor.forwardReceivedEmail({ message: notification() });

    expect(result).toEqual({
      outcome: 'forwarded',
      messageId: 'msg-1',
      ruleIds: ['amazon-returns'],
      recipientCount: 1,
    });
    expect(h.gets).toEqual([{ pk: 'INBOUND', sk: `${RECEIVED_AT}#msg-1` }]);
    expect(h.reads).toEqual(['inbound/msg-1']);
    expect(h.sends).toHaveLength(1);
    const sent = h.sends[0]!;
    expect(sent.from).toBe('forwarding@warehouse.example');
    expect(sent.to).toEqual(['trex@example.com']);
    expect([...sent.cc, ...sent.bcc]).toEqual([]);
    const lines = parseHeaderLines(rootHeaderBlock(Buffer.from(sent.raw))!.toString('latin1'));
    expect(headerValues(lines, 'from')).toEqual(['"Alice (alice@customer.com) via warehouse.example" <forwarding@warehouse.example>']);
    // The targets ride the envelope only; the copy's To header is still the original's.
    expect(headerValues(lines, 'to')).toEqual(['R123@returns.amazon.com']);
    expect(headerValues(lines, 'x-freemail-forwarded')).toEqual(['msg-1']);
    expect(h.forwards).toEqual([
      {
        id: 'msg-1',
        receivedAt: RECEIVED_AT,
        forward: {
          to: ['trex@example.com'],
          ruleIds: ['amazon-returns'],
          sesMessageId: 'ses-fwd-1',
          forwardedAt: NOW.toISOString(),
        },
      },
    ]);
  });

  it('sends once to every matching rule’s targets together', async () => {
    const h = harness({
      rules: [
        AMAZON_RULE,
        forwardingRule({
          id: 'customer',
          senderDomains: ['customer.com'],
          forwardTo: ['ops@example.org'],
        }),
        forwardingRule({
          id: 'other',
          senderDomains: ['other.com'],
          forwardTo: ['never@example.org'],
        }),
      ],
    });

    const result = await h.processor.forwardReceivedEmail({ message: notification() });

    expect(result.ruleIds).toEqual(['amazon-returns', 'customer']);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.to).toEqual(['trex@example.com', 'ops@example.org']);
  });

  it('matches recipient rules on Cc as well as To', async () => {
    const recipients = { to: ['returns@warehouse.example'], cc: ['x@returns.amazon.com'] };
    const h = harness({ row: row(recipients) });

    expect((await h.processor.forwardReceivedEmail({ message: notification(recipients) })).outcome).toBe('forwarded');
  });

  it('still reports forwarded when a concurrent run recorded the forward first', async () => {
    const h = harness({ recorded: false });

    expect((await h.processor.forwardReceivedEmail({ message: notification() })).outcome).toBe('forwarded');
  });

  it('lets an SES failure propagate and records nothing, so the invocation retries', async () => {
    const h = harness({ sendFails: true });

    await expect(h.processor.forwardReceivedEmail({ message: notification() })).rejects.toThrow('TooManyRequestsException');
    expect(h.forwards).toEqual([]);
  });
});

describe('ForwardingProcessor — skipping', () => {
  it.each([
    ['not JSON', 'nope'],
    ['another type', JSON.stringify({ type: 'other', id: 'x' })],
    ['a malformed id', JSON.stringify({ type: 'email.received', id: '!!' })],
    ['a sent message', notification({}, 'SENT')],
    ['an Errors-folder message', notification({}, 'FAILED')],
  ])('skips %s without reading anything', async (_label, message) => {
    const h = harness();

    expect(await h.processor.forwardReceivedEmail({ message })).toEqual({
      outcome: 'skipped',
      reason: 'not a received-email notification',
    });
    expect(h.gets).toEqual([]);
  });

  it('skips a message whose row is gone', async () => {
    const h = harness({ row: null });

    expect((await h.processor.forwardReceivedEmail({ message: notification() })).reason).toBe('message not found');
  });

  it('reports an already-forwarded message as a duplicate, sending nothing', async () => {
    const h = harness({
      row: row({
        forward: {
          to: ['trex@example.com'],
          ruleIds: ['amazon-returns'],
          sesMessageId: 'ses-fwd-0',
          forwardedAt: RECEIVED_AT,
        },
      }),
    });

    expect(await h.processor.forwardReceivedEmail({ message: notification() })).toEqual({
      outcome: 'duplicate',
      messageId: 'msg-1',
    });
    expect(h.reads).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it.each([
    ['spam-flagged', { quarantined: true, spamVerdict: 'FAIL' as const }],
    ['not virus-PASS', { virusVerdict: 'GRAY' as const }],
    ['not fully parsed', { parseStatus: 'limit_exceeded' as const }],
  ])('never forwards a message that is %s', async (_label, overrides) => {
    const h = harness({ row: row(overrides) });

    expect((await h.processor.forwardReceivedEmail({ message: notification() })).reason).toBe('not clean');
    expect(h.reads).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it('rules out a message from the notification alone, reading neither the row nor S3', async () => {
    const h = harness();

    expect(
      await h.processor.forwardReceivedEmail({
        message: notification({ to: ['returns@warehouse.example'], cc: ['x@other.com'] }),
      }),
    ).toEqual({ outcome: 'skipped', messageId: 'msg-1', reason: 'no matching rule' });
    expect(h.gets).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it('rules nothing out from a cut recipient list: the row’s full lists decide', async () => {
    // The 51st To address matches; the notification only carried the first 50.
    const listed = Array.from({ length: 50 }, (_, index) => `r${index}@warehouse.example`);
    const message = notification({ to: listed, recipientsTruncated: true });

    const matching = harness({ row: row({ to: [...listed, 'R123@returns.amazon.com'] }) });
    expect((await matching.processor.forwardReceivedEmail({ message })).outcome).toBe('forwarded');

    const other = harness({ row: row({ to: [...listed, 'x@other.com'] }) });
    expect((await other.processor.forwardReceivedEmail({ message })).reason).toBe('no matching rule');
    expect(other.gets).toHaveLength(1);
    expect(other.reads).toEqual([]);
  });

  it('falls back to the row when the notification’s addresses are missing or malformed', async () => {
    for (const fields of [{ from: undefined, to: undefined, cc: undefined }, { cc: 'x' }]) {
      const h = harness();

      expect((await h.processor.forwardReceivedEmail({ message: notification(fields) })).outcome).toBe('forwarded');
      expect(h.gets).toHaveLength(1);
    }
  });

  it('does not forward on a sender rule when DMARC did not pass for the From domain', async () => {
    const h = harness({
      rules: [CUSTOMER_RULE],
      raw: rawMessage([], 'fail'),
    });

    expect((await h.processor.forwardReceivedEmail({ message: notification() })).reason).toBe('no matching rule (sender not authenticated)');
    expect(h.sends).toEqual([]);
  });

  it('forwards on a sender rule when DMARC passed for the From domain', async () => {
    const h = harness({
      rules: [CUSTOMER_RULE],
    });

    expect((await h.processor.forwardReceivedEmail({ message: notification() })).outcome).toBe('forwarded');
  });

  it('does not forward on a recipient rule when DMARC did not pass either', async () => {
    const h = harness({ raw: rawMessage([], 'fail') });

    expect((await h.processor.forwardReceivedEmail({ message: notification() })).reason).toBe('no matching rule (sender not authenticated)');
    expect(h.sends).toEqual([]);
  });

  it('forwards on a rule that sets ignoreDmarcVerification, DMARC or not', async () => {
    const h = harness({
      rules: [{ ...AMAZON_RULE, ignoreDmarcVerification: true }],
      raw: rawMessage([], 'fail'),
    });

    expect((await h.processor.forwardReceivedEmail({ message: notification() })).outcome).toBe('forwarded');
    expect(h.sends).toHaveLength(1);
  });

  it('never forwards a copy it forwarded before (a loop back to this domain)', async () => {
    const h = harness({ raw: rawMessage(['X-FreeMail-Forwarded: msg-0']) });

    expect((await h.processor.forwardReceivedEmail({ message: notification() })).reason).toBe('already a forwarded copy');
    expect(h.sends).toEqual([]);
  });

  it('skips a message whose raw MIME has expired', async () => {
    const h = harness({ raw: null });

    expect((await h.processor.forwardReceivedEmail({ message: notification() })).reason).toBe('raw message expired');
  });

  it('never forwards to this deployment’s own domain', async () => {
    const own = harness({
      rules: [{ ...AMAZON_RULE, forwardTo: ['Loop@Warehouse.example'] }],
    });
    expect((await own.processor.forwardReceivedEmail({ message: notification() })).reason).toBe('no target outside this domain');
    expect(own.sends).toEqual([]);

    const mixed = harness({
      rules: [{ ...AMAZON_RULE, forwardTo: ['loop@warehouse.example', 'trex@example.com'] }],
    });
    await mixed.processor.forwardReceivedEmail({ message: notification() });
    expect(mixed.sends[0]!.to).toEqual(['trex@example.com']);
  });
});

describe('ForwardingProcessor — a sender rule (Amazon returns)', () => {
  const AMAZON_SENDER_RULE = forwardingRule({
    id: 'amazon-returns',
    senderDomains: ['returns.amazon.com'],
    forwardTo: ['trex@example.com', 'nan@example.com'],
  });

  const AMAZON = 'return-notify@returns.amazon.com';

  function amazonMail(dmarc: string): Buffer {
    return Buffer.from(
      [
        `Authentication-Results: amazonses.com; spf=pass smtp.mailfrom=bounces.amazon.com; dkim=pass header.i=@amazon.com; dmarc=${dmarc} header.from=returns.amazon.com;`,
        `From: Amazon Returns <${AMAZON}>`,
        'To: rma-123@warehouse.example',
        'Subject: Your return is on its way',
        '',
        'Body',
        '',
      ].join('\r\n'),
    );
  }

  function amazonHarness(dmarc: string): Harness {
    return harness({
      rules: [AMAZON_SENDER_RULE],
      row: row({ from: AMAZON, fromName: 'Amazon Returns', to: ['rma-123@warehouse.example'] }),
      raw: amazonMail(dmarc),
    });
  }

  const message = notification({ from: AMAZON, to: ['rma-123@warehouse.example'] });

  it('forwards mail from returns.amazon.com to trex@ and nan@ in one send', async () => {
    const h = amazonHarness('pass');

    expect(await h.processor.forwardReceivedEmail({ message })).toEqual({
      outcome: 'forwarded',
      messageId: 'msg-1',
      ruleIds: ['amazon-returns'],
      recipientCount: 2,
    });
    expect(h.sends.map((sent) => sent.to)).toEqual([['trex@example.com', 'nan@example.com']]);
  });

  it('never forwards a From: returns.amazon.com that fails DMARC (a spoof)', async () => {
    const h = amazonHarness('fail');

    expect((await h.processor.forwardReceivedEmail({ message })).reason).toBe('no matching rule (sender not authenticated)');
    expect(h.sends).toEqual([]);
  });

  it('ignores mail from anyone else, reading nothing', async () => {
    const h = amazonHarness('pass');

    expect((await h.processor.forwardReceivedEmail({ message: notification({ from: 'a@amazon.com' }) })).reason).toBe('no matching rule');
    expect(h.gets).toEqual([]);
    expect(h.reads).toEqual([]);
  });
});

describe('ForwardingProcessor — loop guards, unverified senders, SES rejections', () => {
  const headersOfSent = (h: Harness) => parseHeaderLines(rootHeaderBlock(h.sends[0]!.raw)!.toString('latin1'));

  it('never forwards mail addressed to the forwarding address (a reply to a forward), before reading it', async () => {
    const h = harness({ row: row({ to: ['Forwarding@Warehouse.example'], cc: ['R9@returns.amazon.com'] }) });
    const result = await h.processor.forwardReceivedEmail({ message: notification({ to: ['Forwarding@Warehouse.example'], cc: ['R9@returns.amazon.com'] }) });
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'addressed to the forwarding address' });
    expect(h.reads).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it('never forwards an automatic reply (Auto-Submitted: auto-replied)', async () => {
    const h = harness({ raw: rawMessage(['Auto-Submitted: Auto-Replied; owner-email="x@y.example"']) });
    const result = await h.processor.forwardReceivedEmail({ message: notification() });
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'an automatic reply' });
    expect(h.sends).toEqual([]);
  });

  it('forwards auto-generated mail (notifications, receipts) like any other', async () => {
    const h = harness({ raw: rawMessage(['Auto-Submitted: auto-generated']) });
    expect((await h.processor.forwardReceivedEmail({ message: notification() })).outcome).toBe('forwarded');
  });

  it('marks the copy when a DMARC-skipping rule forwards an unverified sender', async () => {
    const h = harness({ rules: [{ ...AMAZON_RULE, ignoreDmarcVerification: true }], raw: rawMessage([], 'fail') });
    expect((await h.processor.forwardReceivedEmail({ message: notification() })).outcome).toBe('forwarded');
    const lines = headersOfSent(h);
    expect(headerValues(lines, 'x-freemail-sender-verified')).toEqual(['no']);
    expect(headerValues(lines, 'from')[0]).toContain('(unverified) via warehouse.example');
  });

  it('leaves a verified sender’s copy unmarked, even under a DMARC-skipping rule', async () => {
    const h = harness({ rules: [{ ...AMAZON_RULE, ignoreDmarcVerification: true }] });
    await h.processor.forwardReceivedEmail({ message: notification() });
    expect(headerValues(headersOfSent(h), 'x-freemail-sender-verified')).toEqual([]);
    expect(headerValues(headersOfSent(h), 'from')[0]).not.toContain('unverified');
  });

  it.each(['MessageRejected', 'BadRequestException'])('skips, without a retry, a copy SES rejects (%s) — and records no forward', async (name) => {
    const h = harness({ sendError: name });
    const result = await h.processor.forwardReceivedEmail({ message: notification() });
    expect(result).toMatchObject({ outcome: 'skipped', reason: `rejected by SES (${name})` });
    expect(h.forwards).toEqual([]);
  });

  it.each(['TooManyRequestsException', 'SendingPausedException'])('throws on %s, so the queue retries', async (name) => {
    await expect(harness({ sendError: name }).processor.forwardReceivedEmail({ message: notification() })).rejects.toThrow(name);
  });
});
