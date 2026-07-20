import { describe, expect, it } from 'vitest';
import type { EmailDetail } from '@freemail/shared';
import { bodyKind, formatSender, quarantineNotice } from '../../src/lib/email-reader.js';

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
    expect(notice).toEqual({ message: 'This message was flagged as spam.', canReveal: true });
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
});
