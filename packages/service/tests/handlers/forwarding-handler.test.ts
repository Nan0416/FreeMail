import type { SQSEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The processor is the unit under test elsewhere; here, only the wiring: SQS record → processor.
const forwardMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/processors/forwarding-processor.js', () => ({
  ForwardingProcessor: class {
    forwardReceivedEmail = forwardMock;
  },
}));

const ENV = {
  EMAILS_TABLE: 'emails-test',
  FORWARDING_RULES_TABLE: 'rules-test',
  MAIL_BUCKET: 'mail-test',
  EMAIL_DOMAIN: 'warehouse.example',
  SES_CONFIGURATION_SET: 'cfg-test',
};

function sqsEvent(...bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, index) => ({
      messageId: `q-${index + 1}`,
      body,
      attributes: { ApproximateReceiveCount: '1' },
    })),
  } as unknown as SQSEvent;
}

async function loadHandler(env: Record<string, string> = ENV) {
  vi.resetModules();
  for (const name of Object.keys(ENV)) {
    delete process.env[name];
  }
  Object.assign(process.env, env);
  return (await import('../../src/handlers/forwarding.js')).handler;
}

beforeEach(() => {
  forwardMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('forwarding handler', () => {
  it('hands each queue record’s body to the processor, in order', async () => {
    forwardMock.mockResolvedValue({ outcome: 'skipped', reason: 'no matching rule' });
    const handler = await loadHandler();

    const response = await handler(sqsEvent('{"a":1}', '{"b":2}'));

    expect(forwardMock.mock.calls).toEqual([[{ message: '{"a":1}' }], [{ message: '{"b":2}' }]]);
    expect(response).toEqual({ batchItemFailures: [] });
  });

  it('logs one line per message with the outcome, not the addresses', async () => {
    forwardMock.mockResolvedValue({
      outcome: 'forwarded',
      messageId: 'msg-1',
      ruleIds: ['amazon-returns'],
      recipientCount: 1,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = await loadHandler();

    await handler(sqsEvent('{}'));

    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      msg: 'forwarding.processed',
      outcome: 'forwarded',
      messageId: 'msg-1',
      ruleIds: ['amazon-returns'],
      recipientCount: 1,
    });
  });

  it('reports an infra failure as that record’s failure, so only it is redelivered', async () => {
    forwardMock.mockRejectedValueOnce(new Error('ses throttled')).mockResolvedValueOnce({ outcome: 'forwarded', messageId: 'msg-2' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = await loadHandler();

    const response = await handler(sqsEvent('{"a":1}', '{"b":2}'));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'q-1' }] });
    expect(forwardMock).toHaveBeenCalledTimes(2);
    expect(String(errors.mock.calls[0]?.[0])).toContain('q-1');
  });

  it('fails at start-up naming every missing variable', async () => {
    const handler = await loadHandler({ EMAILS_TABLE: 'emails-test' });

    const error = await handler(sqsEvent('{}')).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    for (const name of ['FORWARDING_RULES_TABLE', 'MAIL_BUCKET', 'EMAIL_DOMAIN', 'SES_CONFIGURATION_SET']) {
      expect((error as Error).message).toContain(name);
    }
  });
});
