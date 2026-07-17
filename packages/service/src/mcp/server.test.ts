import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailErrors } from '../email/errors.js';
import type { EmailService } from '../email/service.js';
import { buildMcpServer } from './server.js';

/**
 * Drive the real MCP protocol over an in-memory client/server pair so schema
 * fidelity and the success/known-failure/unexpected-failure contracts are
 * exercised end-to-end (initialize handshake included), not just at the callback.
 */
async function connect(send: ReturnType<typeof vi.fn>): Promise<Client> {
  const emailService = { send } as unknown as EmailService;
  const server = buildMcpServer(emailService);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('buildMcpServer send_email', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advertises send_email with a type-only schema (only `from` required)', async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();

    const sendEmail = tools.find((tool) => tool.name === 'send_email');
    expect(sendEmail).toBeDefined();
    expect(Object.keys(sendEmail?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        'from',
        'fromName',
        'to',
        'cc',
        'bcc',
        'subject',
        'text',
        'html',
        'attachments',
      ]),
    );
    // Cross-field rules (≥1 recipient, ≥1 body) live in EmailService, not the schema.
    expect(sendEmail?.inputSchema.required).toEqual(['from']);
    expect(Object.keys(sendEmail?.outputSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(['id', 'messageId', 'sentAt']),
    );
  });

  it('returns structuredContent + a text summary on a successful send', async () => {
    const send = vi.fn().mockResolvedValue({
      id: 'email-1',
      messageId: 'ses-1',
      sentAt: '2026-07-17T00:00:00.000Z',
    });
    const client = await connect(send);

    const result = await client.callTool({
      name: 'send_email',
      arguments: { from: 'me@example.com', to: ['you@elsewhere.com'], text: 'hi' },
    });

    expect(send).toHaveBeenCalledWith({
      from: 'me@example.com',
      to: ['you@elsewhere.com'],
      text: 'hi',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      id: 'email-1',
      messageId: 'ses-1',
      sentAt: '2026-07-17T00:00:00.000Z',
    });
    expect((result.content as { text: string }[])[0]?.text).toContain('email-1');
  });

  it('surfaces a known EmailError as an isError tool result carrying the code', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(
        emailErrors.invalidSender('"x@evil.com" is not under the configured domain (example.com).'),
      );
    const client = await connect(send);

    const result = await client.callTool({
      name: 'send_email',
      arguments: { from: 'x@evil.com', to: ['you@elsewhere.com'], text: 'hi' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toBe(
      'invalid_sender: "x@evil.com" is not under the configured domain (example.com).',
    );
  });

  it('returns a generic isError for an unexpected failure and does not leak internals', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new Error('SES exploded: secret internal detail'));
    const client = await connect(send);

    const result = await client.callTool({
      name: 'send_email',
      arguments: { from: 'me@example.com', to: ['you@elsewhere.com'], text: 'hi' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text).toBe('Failed to send the email due to an internal error.');
    expect(text).not.toContain('SES exploded');
    expect(text).not.toContain('secret');
    // Logged server-side with context for operators.
    expect(consoleError).toHaveBeenCalled();
  });
});
