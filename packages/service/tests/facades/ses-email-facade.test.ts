import type { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it } from 'vitest';
import { SesV2Sender } from '../../src/facades/ses-email-facade.js';

function capture(): { client: SESv2Client; commands: SendEmailCommand[] } {
  const commands: SendEmailCommand[] = [];
  const client = {
    send(command: SendEmailCommand) {
      commands.push(command);
      return Promise.resolve({ MessageId: 'ses-1' });
    },
  } as unknown as SESv2Client;
  return { client, commands };
}

describe('SesV2Sender', () => {
  it('sends the raw message through the configuration set, with its tags', async () => {
    const fake = capture();
    const sender = new SesV2Sender({ client: fake.client, configurationSetName: 'cfg' });

    const result = await sender.send({
      from: 'me@example.com',
      to: ['a@x.com'],
      cc: [],
      bcc: ['b@x.com'],
      raw: Buffer.from('RAW'),
      tags: { 'freemail-id': 'row-1', 'freemail-sent': '1760097600123' },
    });

    expect(result).toEqual({ messageId: 'ses-1' });
    expect(fake.commands[0]?.input).toMatchObject({
      FromEmailAddress: 'me@example.com',
      Destination: { ToAddresses: ['a@x.com'], CcAddresses: [], BccAddresses: ['b@x.com'] },
      ConfigurationSetName: 'cfg',
      EmailTags: [
        { Name: 'freemail-id', Value: 'row-1' },
        { Name: 'freemail-sent', Value: '1760097600123' },
      ],
    });
  });

  it('sends no tags when none are given', async () => {
    const fake = capture();

    await new SesV2Sender({ client: fake.client }).send({
      from: 'me@example.com',
      to: ['a@x.com'],
      cc: [],
      bcc: [],
      raw: Buffer.from('RAW'),
    });

    expect(fake.commands[0]?.input.EmailTags).toBeUndefined();
  });
});
