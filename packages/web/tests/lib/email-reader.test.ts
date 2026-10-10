import { describe, expect, it } from 'vitest';
import type { EmailDetail } from '@freemail/shared';
import {
  bodyKind,
  failureReason,
  formatSender,
  quarantineNotice,
  sentStatusNotice,
} from '../../src/lib/email-reader.js';

function inbound(overrides: Partial<EmailDetail> = {}): EmailDetail {
  return {
    id: 'h1',
    direction: 'inbound',
    from: 'a@x.com',
    to: ['me@y.com'],
    cc: [],
    subject: 'Hi',
    date: '2026-07-17T00:00:00.000Z',
    attachments: [],
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 100,
    ...overrides,
  };
}

describe('bodyKind', () => {
  it('prefers html, falls back to text, else none', () => {
    expect(bodyKind(inbound({ html: '<p>x</p>', text: 'x' }))).toBe('html');
    expect(bodyKind(inbound({ text: 'x' }))).toBe('text');
    expect(bodyKind(inbound())).toBe('none');
  });
});

describe('formatSender', () => {
  it('uses "Name <addr>" when a display name exists', () => {
    expect(formatSender({ from: 'a@x.com', fromName: 'Ada' })).toBe('Ada <a@x.com>');
    expect(formatSender({ from: 'a@x.com' })).toBe('a@x.com');
  });
});

describe('quarantineNotice', () => {
  it('returns null for a non-quarantined inbound message and for sent', () => {
    expect(quarantineNotice(inbound({ quarantined: false, html: '<p>x</p>' }))).toBeNull();
    expect(quarantineNotice(inbound({ direction: 'sent', quarantined: true }))).toBeNull();
  });

  it('spam-flagged with a body → revealable', () => {
    const notice = quarantineNotice(
      inbound({ quarantined: true, spamVerdict: 'FAIL', virusVerdict: 'PASS', text: 'body' }),
    );
    expect(notice).toEqual({
      message: 'This message was flagged as spam.',
      canReveal: true,
      offerDownload: false,
      suspicious: false,
    });
  });

  it('virus-fail → NOT revealable (no body exists to show)', () => {
    const notice = quarantineNotice(
      inbound({ quarantined: true, virusVerdict: 'FAIL', spamVerdict: 'PASS' }),
    );
    expect(notice?.canReveal).toBe(false);
    expect(notice?.message).toMatch(/virus/i);
  });

  it('parse-failed → NOT revealable', () => {
    const notice = quarantineNotice(
      inbound({ quarantined: true, virusVerdict: 'PASS', parseStatus: 'parse_failed' }),
    );
    expect(notice?.canReveal).toBe(false);
    expect(notice?.message).toMatch(/parse/i);
  });

  it('a failed message whose original is offered → download, with a warning without a virus PASS', () => {
    const suspicious = quarantineNotice(
      inbound({
        quarantined: true,
        failed: true,
        virusVerdict: 'FAIL',
        rawAvailable: true,
        rawSuspicious: true,
      }),
    );
    expect(suspicious).toMatchObject({ offerDownload: true, suspicious: true, canReveal: false });
    expect(suspicious?.message).toMatch(/not confirm it is virus-free/);

    const clean = quarantineNotice(
      inbound({
        quarantined: true,
        failed: true,
        virusVerdict: 'PASS',
        parseStatus: 'limit_exceeded',
        rawAvailable: true,
      }),
    );
    expect(clean).toMatchObject({ offerDownload: true, suspicious: false });
    expect(clean?.message).toMatch(/download the original/);
  });

  it('offers no download when the server does not', () => {
    const notice = quarantineNotice(
      inbound({ quarantined: true, failed: true, virusVerdict: 'FAIL', rawAvailable: false }),
    );
    expect(notice).toMatchObject({ offerDownload: false, suspicious: false });
  });
});

describe('failureReason', () => {
  it('names the virus verdict first — it outranks a parse problem', () => {
    expect(failureReason({ virusVerdict: 'FAIL', parseStatus: 'parse_failed' })).toMatchObject({
      label: 'Virus',
      suspicious: true,
    });
    expect(failureReason({ virusVerdict: 'GRAY' })?.label).toBe('Suspicious');
    expect(failureReason({ virusVerdict: 'ABSENT' })?.label).toBe('Not scanned');
    expect(failureReason({ virusVerdict: 'PROCESSING_FAILED' })?.label).toBe('Not scanned');
  });

  it('names the parse problem of clean mail, not suspicious', () => {
    expect(failureReason({ virusVerdict: 'PASS', parseStatus: 'oversize' })).toMatchObject({
      label: 'Too large',
      suspicious: false,
    });
    expect(failureReason({ virusVerdict: 'PASS', parseStatus: 'limit_exceeded' })?.label).toBe(
      'Over limits',
    );
    expect(failureReason({ virusVerdict: 'PASS', parseStatus: 'parse_failed' })?.label).toBe(
      'Unreadable',
    );
  });

  it('is null for clean, parsed mail (at most spam)', () => {
    expect(failureReason({ virusVerdict: 'PASS', parseStatus: 'ok' })).toBeNull();
  });
});

describe('sentStatusNotice', () => {
  it('is null for inbound, delivered, and legacy (status-less) sent mail', () => {
    expect(sentStatusNotice(inbound())).toBeNull();
    expect(sentStatusNotice(inbound({ direction: 'sent', status: 'sent' }))).toBeNull();
    expect(sentStatusNotice(inbound({ direction: 'sent' }))).toBeNull();
  });

  it('explains a failed or still-sending message', () => {
    expect(sentStatusNotice(inbound({ direction: 'sent', status: 'send_failed' }))).toMatch(
      /failed to send/i,
    );
    expect(sentStatusNotice(inbound({ direction: 'sent', status: 'sending' }))).toMatch(
      /still sending/i,
    );
  });
});
