/**
 * SES delivery reports → the sent message's row. SES publishes what happens to a message after
 * it accepted it — delivered, bounced, complained, delayed, rejected — through the
 * configuration set's SNS destination; this records each report on the message it is about, so
 * the mailbox (and an agent) can see whether mail arrived.
 *
 * A report finds its row through the message tags every send carries (see
 * `utils/delivery-tags.ts`): the row id and the send time, which together are its sort key. A report
 * without them — mail sent before tags, or not by FreeMail — is skipped, and so is one whose row
 * is gone. Only a storage failure throws, so the async invocation retries; SNS delivers at least
 * once, and a repeated report just appends a duplicate the reader folds away.
 */
import type { DeliveryEvent, SentStatus } from '@freemail/shared';
import type { EmailsDao } from '../data/emails-dao.js';
import { DELIVERY_TAG_ID, DELIVERY_TAG_SENT } from '../utils/delivery-tags.js';

export interface ProcessSesEventRequest {
  /** The SNS message body: SES's event JSON. */
  readonly message: string;
}

export interface ProcessSesEventResponse {
  readonly outcome: 'recorded' | 'skipped';
  /** Why a report was skipped. */
  readonly reason?: string;
  /** The message's row id, when the report named one. */
  readonly emailId?: string;
}

/** Recipients kept per report — SES's own per-message cap. */
const MAX_RECIPIENTS = 50;
/** Characters kept of an address, and of a reason. */
const MAX_ADDRESS_CHARS = 320;
const MAX_DETAIL_CHARS = 300;

export class SesEventProcessor {
  private readonly emails: EmailsDao;

  constructor(emails: EmailsDao) {
    this.emails = emails;
  }

  async processSesEvent(request: ProcessSesEventRequest): Promise<ProcessSesEventResponse> {
    let event: SesEvent;
    try {
      event = JSON.parse(request.message) as SesEvent;
    } catch {
      return { outcome: 'skipped', reason: 'not JSON' };
    }
    const tags = event.mail?.tags ?? {};
    const id = tags[DELIVERY_TAG_ID]?.[0];
    const sentMs = Number(tags[DELIVERY_TAG_SENT]?.[0]);
    if (typeof id !== 'string' || id.length === 0 || !Number.isFinite(sentMs)) {
      return { outcome: 'skipped', reason: 'no FreeMail tags' };
    }
    const report = toReport(event);
    if (report === undefined) {
      return {
        outcome: 'skipped',
        reason: `untracked event ${String(eventTypeOf(event))}`,
        emailId: id,
      };
    }
    const result = await this.emails.updateSentEmailDelivery({
      id,
      sentAt: new Date(sentMs).toISOString(),
      events: [report.event],
      ...(report.status !== undefined ? { status: report.status } : {}),
    });
    return result.found
      ? { outcome: 'recorded', emailId: id }
      : { outcome: 'skipped', reason: 'no such message', emailId: id };
  }
}

/** One report, as a row event plus the status it moves the message to (if any). */
interface Report {
  readonly event: DeliveryEvent;
  readonly status?: Extract<SentStatus, 'delivered' | 'bounced' | 'send_failed'>;
}

function toReport(event: SesEvent): Report | undefined {
  const fallbackAt = event.mail?.timestamp;
  switch (eventTypeOf(event)) {
    case 'Delivery':
      return {
        event: deliveryEvent('delivered', event.delivery?.timestamp ?? fallbackAt, {
          recipients: event.delivery?.recipients,
        }),
        status: 'delivered',
      };
    case 'Bounce': {
      const bounce = event.bounce;
      const diagnostic = bounce?.bouncedRecipients?.find((r) => r.diagnosticCode)?.diagnosticCode;
      return {
        event: deliveryEvent('bounced', bounce?.timestamp ?? fallbackAt, {
          recipients: bounce?.bouncedRecipients?.map((r) => r.emailAddress),
          detail: joinDetail([bounce?.bounceType, bounce?.bounceSubType], diagnostic),
        }),
        status: 'bounced',
      };
    }
    case 'Complaint':
      return {
        event: deliveryEvent('complained', event.complaint?.timestamp ?? fallbackAt, {
          recipients: event.complaint?.complainedRecipients?.map((r) => r.emailAddress),
          detail: event.complaint?.complaintFeedbackType,
        }),
      };
    case 'DeliveryDelay': {
      const delay = event.deliveryDelay;
      const diagnostic = delay?.delayedRecipients?.find((r) => r.diagnosticCode)?.diagnosticCode;
      return {
        event: deliveryEvent('delayed', delay?.timestamp ?? fallbackAt, {
          recipients: delay?.delayedRecipients?.map((r) => r.emailAddress),
          detail: joinDetail([delay?.delayType], diagnostic),
        }),
      };
    }
    case 'Reject':
      return {
        event: deliveryEvent('rejected', fallbackAt, { detail: event.reject?.reason }),
        status: 'send_failed',
      };
    default:
      return undefined;
  }
}

/** Configuration-set events say `eventType`; identity notifications say `notificationType`. */
function eventTypeOf(event: SesEvent): string | undefined {
  return event.eventType ?? event.notificationType;
}

function deliveryEvent(
  type: DeliveryEvent['type'],
  at: string | undefined,
  parts: {
    readonly recipients?: ReadonlyArray<string | undefined> | undefined;
    readonly detail?: string | undefined;
  },
): DeliveryEvent {
  const parsed = at === undefined ? Number.NaN : Date.parse(at);
  const recipients = (parts.recipients ?? [])
    .filter((address): address is string => typeof address === 'string')
    .slice(0, MAX_RECIPIENTS)
    .map((address) => clean(address, MAX_ADDRESS_CHARS))
    .filter((address) => address.length > 0);
  const detail = clean(parts.detail, MAX_DETAIL_CHARS);
  return {
    type,
    at: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
    recipients,
    ...(detail ? { detail } : {}),
  };
}

/** Control characters and line breaks (a remote server wrote some of this) → one capped line. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/g;

function clean(value: string | undefined, maxChars: number): string {
  const line = (value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return line.length > maxChars ? line.slice(0, maxChars) : line;
}

/** `Permanent/General: smtp; 550 5.1.1 user unknown`. */
function joinDetail(
  kinds: ReadonlyArray<string | undefined>,
  diagnostic: string | undefined,
): string {
  const kind = kinds.filter((part) => part !== undefined && part !== '').join('/');
  return [kind, diagnostic].filter((part) => part !== undefined && part !== '').join(': ');
}

/** The parts of SES's event JSON this reads — everything optional: it is external input. */
interface SesEvent {
  readonly eventType?: string;
  readonly notificationType?: string;
  readonly mail?: {
    readonly timestamp?: string;
    readonly tags?: Readonly<Record<string, readonly string[] | undefined>>;
  };
  readonly delivery?: { readonly timestamp?: string; readonly recipients?: readonly string[] };
  readonly bounce?: {
    readonly timestamp?: string;
    readonly bounceType?: string;
    readonly bounceSubType?: string;
    readonly bouncedRecipients?: readonly {
      readonly emailAddress?: string;
      readonly diagnosticCode?: string;
    }[];
  };
  readonly complaint?: {
    readonly timestamp?: string;
    readonly complaintFeedbackType?: string;
    readonly complainedRecipients?: readonly { readonly emailAddress?: string }[];
  };
  readonly deliveryDelay?: {
    readonly timestamp?: string;
    readonly delayType?: string;
    readonly delayedRecipients?: readonly {
      readonly emailAddress?: string;
      readonly diagnosticCode?: string;
    }[];
  };
  readonly reject?: { readonly reason?: string };
}
