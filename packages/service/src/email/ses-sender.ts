/**
 * The SES port the {@link EmailService} sends through, plus its SESv2
 * implementation. The service depends on the interface so its logic is testable
 * with a fake; only this file touches the AWS SDK.
 *
 * We send the raw MIME (`Content.Raw`) and pass the full recipient set — including
 * BCC — as the SES `Destination` envelope. Blind recipients are therefore
 * delivered without ever appearing in the message headers (see `mime.ts`).
 * `ConfigurationSetName` routes the send through #3's config set so suppression +
 * bounce/complaint tracking apply.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface SendRawParams {
  readonly from: string;
  /** Envelope recipients (headers carry to/cc; bcc rides only here). */
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  /** The assembled raw MIME message. */
  readonly raw: Uint8Array;
}

export interface SesSender {
  /** Send a raw MIME message; resolves to the SES message id. */
  send(params: SendRawParams): Promise<{ readonly messageId: string }>;
}

export class SesV2Sender implements SesSender {
  private readonly client: SESv2Client;
  private readonly configurationSetName: string | undefined;

  constructor(deps: { client?: SESv2Client; configurationSetName?: string } = {}) {
    this.client = deps.client ?? new SESv2Client({});
    this.configurationSetName = deps.configurationSetName;
  }

  async send(params: SendRawParams): Promise<{ messageId: string }> {
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: params.from,
        Destination: {
          ToAddresses: [...params.to],
          CcAddresses: [...params.cc],
          BccAddresses: [...params.bcc],
        },
        Content: { Raw: { Data: params.raw } },
        ...(this.configurationSetName ? { ConfigurationSetName: this.configurationSetName } : {}),
      }),
    );
    return { messageId: result.MessageId ?? '' };
  }
}
