# @freemail/client

A TypeScript client for the API of a [FreeMail](https://github.com/Nan0416/FreeMail) deployment. It sends email, uploads attachments, fetches received messages and reads new-mail notifications, authorized with an API key.

```sh
npm install @freemail/client
```

Requires Node.js 22 or later (or any runtime with `fetch`). ESM only.

## Setup

You need two things from your deployment:

- **The API's address:** `https://<apiDomain>`, the `ApiCustomDomainUrl` stack output.
- **An API key:** in the FreeMail web app, open **MCP server** and create an access key (`fm_...`). It's shown once. One key per service lets you revoke one without the others.

```ts
import { FreeMailClientImpl, type FreeMailClient } from '@freemail/client';

const freemail: FreeMailClient = new FreeMailClientImpl({
  baseUrl: 'https://api.mail.example.com',
  apiKey: process.env.FREEMAIL_API_KEY!,
});
```

## Send an email

```ts
const sent = await freemail.sendEmail({
  from: 'orders@mail.example.com', // any address under the deployment's domain
  to: ['sam@example.com'],
  subject: 'Your order shipped',
  text: 'It is on its way.',
  html: '<p>It is on its way.</p>',
  idempotencyKey: 'order-1234-shipped', // optional: makes a retry safe for 24 hours
});
// sent.id is the message's id, for getEmail
```

Mail really goes out. Without an `idempotencyKey`, retrying a call that timed out can send the message twice; with one, the retry returns the first send's response (`replayed: true`).

### Attachments

```ts
import { readFile } from 'node:fs/promises';

const invoice = await freemail.uploadAttachment({
  filename: 'invoice.pdf',
  contentType: 'application/pdf',
  content: await readFile('invoice.pdf'), // up to 100 MB
});

await freemail.sendEmail({ from: 'billing@mail.example.com', to: ['sam@example.com'], subject: 'Invoice', text: 'Attached.', attachments: [invoice] });
```

`uploadAttachment` asks FreeMail for a presigned upload URL and PUTs the bytes straight to S3; the API key never goes to S3. To stream a file instead, call `createAttachmentUpload` and PUT to its `uploadUrl` yourself. To forward a file already on a message, pass `{ emailId, attachmentId }` in `attachments`. The server copies it.

## Read received mail

With inbound enabled, the deployment publishes each received message to the SNS topic in its `EmailReceivedTopicArn` stack output. Subscribe an SQS queue (or a Lambda) to it, then fetch each message:

```ts
import type { SQSHandler } from 'aws-lambda';
import { parseEmailReceivedNotification } from '@freemail/client';

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const notification = parseEmailReceivedNotification(record.body);
    if (notification.spam) {
      continue;
    }
    const email = await freemail.getEmail({ id: notification.id });
    // email.text, email.html, email.attachments[i].downloadUrl
  }
};
```

- **At least once:** the same notification can arrive more than once. De-duplicate on `notification.id`.
- `parseEmailReceivedNotification` reads a raw-delivery SQS body, an SNS envelope (a subscription without raw delivery), or a Lambda SNS record's `Sns.Message`.
- **Download URLs** on `email.attachments` are valid for 5 minutes. Call `getEmail` again for fresh ones.
- **Received mail is written by its sender.** `html` is raw: sanitize it before rendering, and never treat `from` as proof of who sent it.

## Errors

The client's own errors:

| Class                                 | When                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `FreeMailAuthError`                   | 401 or 403: the API key is missing, wrong or revoked.                                                                       |
| `FreeMailEmailNotFoundError`          | `getEmail` for an id the deployment does not hold.                                                                          |
| `FreeMailApiError`                    | Any other error response. `status`, plus FreeMail's `code` (`invalid_request`, `invalid_sender`, ...) when it sent one.     |
| `FreeMailResponseValidationError`     | A 2xx response that is not what the call returns, for example from a deployment newer than this client. Upgrade the client. |
| `FreeMailUploadError`                 | S3 refused an attachment's bytes: the upload URL expired, or the bytes are not the declared size.                           |
| `FreeMailNotificationValidationError` | `parseEmailReceivedNotification` got something other than an email-received notification.                                   |

`FreeMailAuthError` and `FreeMailEmailNotFoundError` extend `FreeMailApiError`. A timeout rejects with the runtime's `TimeoutError`, an aborted call with the signal's reason, and a network failure with `fetch`'s own error.

## Options

```ts
new FreeMailClientImpl({
  baseUrl: 'https://api.mail.example.com',
  apiKey: '...',
  timeoutMs: 10_000, // per API call; 30 seconds by default
  fetch: myFetch, // any fetch implementation; the global fetch by default
});

await freemail.getEmail({ id }, { signal: AbortSignal.timeout(5_000) }); // per-call signal or timeoutMs
```

Uploading an attachment's bytes gets 15 minutes by default, the upload URL's lifetime.

## Testing your code

Depend on the `FreeMailClient` interface and give your tests a fake that implements it, rather than calling a real deployment.

## Compatibility

The client validates every response. Fields a newer deployment adds pass through untouched, but a value the client doesn't know (a new delivery status, say) throws `FreeMailResponseValidationError`, so keep the client at least as new as your deployment.

## License

MIT
