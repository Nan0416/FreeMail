import type { SNSEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The processor is the unit under test elsewhere; here, only the wiring: SNS record → processor.
const processMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/processors/ses-event-processor.js', () => ({
  SesEventProcessor: class {
    processSesEvent = processMock;
  },
}));

function snsEvent(...messages: string[]): SNSEvent {
  return {
    Records: messages.map((message) => ({ Sns: { Message: message } })),
  } as unknown as SNSEvent;
}

async function loadHandler() {
  vi.resetModules();
  process.env.EMAILS_TABLE = 'emails-test';
  return (await import('../../src/handlers/ses-events.js')).handler;
}

beforeEach(() => {
  processMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('SES events handler', () => {
  it('hands each SNS record’s message to the processor, in order', async () => {
    processMock.mockResolvedValue({ outcome: 'recorded', emailId: 'row-1' });
    const handler = await loadHandler();

    await handler(snsEvent('{"a":1}', '{"b":2}'));

    expect(processMock.mock.calls).toEqual([[{ message: '{"a":1}' }], [{ message: '{"b":2}' }]]);
  });

  it('lets a storage failure propagate, so the async invocation retries', async () => {
    processMock.mockRejectedValue(new Error('ddb down'));
    const handler = await loadHandler();

    await expect(handler(snsEvent('{}'))).rejects.toThrow('ddb down');
  });

  it('fails at start-up without its table', async () => {
    vi.resetModules();
    delete process.env.EMAILS_TABLE;
    const handler = (await import('../../src/handlers/ses-events.js')).handler;

    await expect(handler(snsEvent('{}'))).rejects.toThrow(/EMAILS_TABLE/);
  });
});
