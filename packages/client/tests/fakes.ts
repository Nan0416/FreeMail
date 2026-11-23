import type { FetchLike, FetchLikeInit, FetchLikeResponse } from '../src/types/http.js';
import type { EmailReceivedNotification } from '../src/types/notifications.js';
import type { ServiceEmailDetail } from '../src/types/service.js';

export const BASE_URL = 'https://api.example.com';
export const API_KEY = 'fm_test-key';

export interface FakeReply {
  readonly status?: number;
  /** An object is sent as JSON; a string as is. */
  readonly body?: unknown;
}

export interface RecordedRequest {
  readonly url: string;
  readonly init: FetchLikeInit;
}

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
}

/** Answers each request with `reply(request)`, recording what was sent. */
export function fakeFetch(reply: (request: RecordedRequest) => FakeReply): FakeFetch {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const request = { url, init };
    requests.push(request);
    return response(reply(request));
  };
  return { fetch, requests };
}

function response(reply: FakeReply): FetchLikeResponse {
  const status = reply.status ?? 200;
  const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

/** A fetch that never answers: it rejects with the signal's reason once the call is aborted. */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });

/** Every field, optional ones included, so a schema that forgets one fails `schemaKeys` checks. */
export type Complete<T> = { readonly [K in keyof T]-?: T[K] };

export const EMAIL_ID = 'eyJ2IjoxLCJwayI6IklOQk9VTkQiLCJzayI6ImVtYWlsLTEifQ';

export function buildServiceEmailDetail(overrides: Partial<ServiceEmailDetail> = {}): ServiceEmailDetail {
  return {
    id: EMAIL_ID,
    direction: 'inbound',
    from: 'billing@vendor.example.com',
    fromName: 'Vendor Billing',
    to: ['alex@corp.example'],
    cc: [],
    subject: 'Invoice 1234',
    date: '2026-11-13T17:00:05.000Z',
    headerDate: '2026-11-13T17:00:04.000Z',
    text: 'Your invoice is attached.',
    html: '<p>Your invoice is attached.</p>',
    attachments: [
      {
        id: '0',
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        downloadUrl: 'https://s3.example/attachments/inbound/x?X-Amz-Signature=abc',
        downloadUrlExpiresAt: '2026-11-13T17:05:05.000Z',
      },
    ],
    hasAttachments: true,
    attachmentCount: 1,
    quarantined: false,
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    parseStatus: 'ok',
    sizeBytes: 4200,
    ...overrides,
  };
}

/** A sent message with every field set, for the schema's field-coverage check. */
export const COMPLETE_SERVICE_EMAIL_DETAIL: Complete<ServiceEmailDetail> = {
  id: EMAIL_ID,
  direction: 'sent',
  from: 'agent@corp.example',
  fromName: 'Agent',
  to: ['sam@example.com'],
  cc: ['alex@example.com'],
  bcc: ['audit@corp.example'],
  replyTo: ['support@corp.example'],
  subject: 'Re: Invoice 1234',
  date: '2026-11-13T17:00:05.000Z',
  status: 'delivered',
  deliveryEvents: [{ type: 'delivered', at: '2026-11-13T17:00:07.000Z', recipients: ['sam@example.com'], detail: 'none' }],
  headerDate: '2026-11-13T17:00:04.000Z',
  text: 'Thanks.',
  html: '<p>Thanks.</p>',
  bodyTruncated: false,
  attachments: [],
  hasAttachments: false,
  attachmentCount: 0,
  quarantined: false,
  spamVerdict: 'PASS',
  virusVerdict: 'PASS',
  parseStatus: 'ok',
  failed: false,
  sizeBytes: 2048,
};

export function buildEmailReceivedNotification(overrides: Partial<EmailReceivedNotification> = {}): EmailReceivedNotification {
  return {
    version: 1,
    type: 'email.received',
    id: EMAIL_ID,
    receivedAt: '2026-11-13T17:00:05.000Z',
    from: 'billing@vendor.example.com',
    to: ['alex@corp.example'],
    cc: [],
    subject: 'Invoice 1234',
    hasAttachments: true,
    attachmentCount: 1,
    sizeBytes: 4200,
    spam: false,
    spamVerdict: 'PASS',
    ...overrides,
  };
}

export const COMPLETE_EMAIL_RECEIVED_NOTIFICATION: Complete<EmailReceivedNotification> = {
  ...buildEmailReceivedNotification(),
  fromName: 'Vendor Billing',
  recipientsTruncated: true,
};
