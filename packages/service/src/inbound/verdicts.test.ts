import { describe, expect, it } from 'vitest';
import { parseHeaderLines } from './headers.js';
import { decideExposure, extractVerdicts, verdictFromHeaders } from './verdicts.js';

const lines = (raw: string) => parseHeaderLines(raw);

describe('verdictFromHeaders', () => {
  it('normalizes a single known verdict', () => {
    expect(verdictFromHeaders(lines('X-SES-Spam-Verdict: PASS'), 'x-ses-spam-verdict')).toBe(
      'PASS',
    );
    expect(verdictFromHeaders(lines('X-SES-Virus-Verdict: FAIL'), 'x-ses-virus-verdict')).toBe(
      'FAIL',
    );
    expect(verdictFromHeaders(lines('X-SES-Spam-Verdict: GRAY'), 'x-ses-spam-verdict')).toBe(
      'GRAY',
    );
    expect(
      verdictFromHeaders(lines('X-SES-Virus-Verdict: PROCESSING_FAILED'), 'x-ses-virus-verdict'),
    ).toBe('PROCESSING_FAILED');
  });

  it('is ABSENT when the header is missing', () => {
    expect(verdictFromHeaders(lines('From: a@b.com'), 'x-ses-spam-verdict')).toBe('ABSENT');
  });

  it('takes the FIRST occurrence — but flags a duplicate/injected header as CONFLICTING', () => {
    // SES prepends its verdict (FAIL); an attacker injects a later forged PASS.
    const raw = 'X-SES-Spam-Verdict: FAIL\r\nReceived: smtp\r\nX-SES-Spam-Verdict: PASS';
    expect(verdictFromHeaders(lines(raw), 'x-ses-spam-verdict')).toBe('CONFLICTING');
  });

  it('is UNKNOWN for an unrecognized token', () => {
    expect(verdictFromHeaders(lines('X-SES-Virus-Verdict: WHATEVER'), 'x-ses-virus-verdict')).toBe(
      'UNKNOWN',
    );
  });
});

describe('extractVerdicts', () => {
  it('reads both SES verdicts', () => {
    expect(extractVerdicts(lines('X-SES-Spam-Verdict: PASS\r\nX-SES-Virus-Verdict: PASS'))).toEqual(
      { spamVerdict: 'PASS', virusVerdict: 'PASS' },
    );
  });
});

describe('decideExposure — fail closed', () => {
  it('exposes content only when parsed AND virus is an affirmative PASS', () => {
    expect(decideExposure({ spamVerdict: 'PASS', virusVerdict: 'PASS' }, 'ok')).toEqual({
      exposeContent: true,
      quarantined: false,
    });
  });

  it('quarantines (hidden) but still exposes content for spam-FAIL + virus-PASS', () => {
    expect(decideExposure({ spamVerdict: 'FAIL', virusVerdict: 'PASS' }, 'ok')).toEqual({
      exposeContent: true,
      quarantined: true,
    });
  });

  it.each(['FAIL', 'GRAY', 'PROCESSING_FAILED', 'CONFLICTING', 'ABSENT', 'UNKNOWN'] as const)(
    'suppresses content when virus verdict is %s (no affirmative PASS)',
    (virusVerdict) => {
      expect(decideExposure({ spamVerdict: 'PASS', virusVerdict }, 'ok')).toEqual({
        exposeContent: false,
        quarantined: true,
      });
    },
  );

  it.each(['oversize', 'limit_exceeded', 'parse_failed'] as const)(
    'suppresses content when parse status is %s even with virus PASS',
    (parseStatus) => {
      expect(decideExposure({ spamVerdict: 'PASS', virusVerdict: 'PASS' }, parseStatus)).toEqual({
        exposeContent: false,
        quarantined: true,
      });
    },
  );
});
