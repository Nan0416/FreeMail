import { describe, expect, it } from 'vitest';
import { parseHeaderLines } from '../../src/utils/inbound-headers.js';
import { dmarcPassDomain } from '../../src/utils/sender-auth.js';

/** SES's own header, as it prepends it (folded, like the real one). */
const SES_PASS = [
  'Authentication-Results: amazonses.com;',
  ' spf=pass (spfCheck: domain of example.com designates 192.0.2.1 as permitted sender) client-ip=192.0.2.1; envelope-from=me@example.com; helo=a.example.com;',
  ' dkim=pass header.i=@example.com;',
  ' dkim=pass header.i=@amazonses.com;',
  ' dmarc=pass header.from=example.com;',
].join('\r\n');

function domain(block: string): string | undefined {
  return dmarcPassDomain(parseHeaderLines(block));
}

describe('dmarcPassDomain', () => {
  it('reads the From domain SES’s DMARC check passed for', () => {
    expect(domain(`${SES_PASS}\r\nFrom: me@example.com`)).toBe('example.com');
    expect(
      domain('Authentication-Results: AmazonSES.com; dmarc=pass header.from="Example.COM";'),
    ).toBe('example.com');
  });

  it.each([
    ['DMARC failed', 'Authentication-Results: amazonses.com; dmarc=fail header.from=example.com;'],
    ['no DMARC result', 'Authentication-Results: amazonses.com; dkim=pass header.i=@example.com;'],
    ['no header at all', 'From: me@example.com'],
    [
      'the first header is not SES’s',
      'Authentication-Results: mx.evil.example; dmarc=pass header.from=example.com;',
    ],
  ])('answers undefined when %s', (_label, block) => {
    expect(domain(block)).toBeUndefined();
  });

  it('trusts only the first header — a sender-supplied pass below SES’s is ignored', () => {
    expect(
      domain(
        [
          'Authentication-Results: amazonses.com; dmarc=fail header.from=example.com;',
          'Authentication-Results: amazonses.com; dmarc=pass header.from=example.com;',
        ].join('\r\n'),
      ),
    ).toBeUndefined();
  });

  it('fails closed when a pass is smuggled into a sender-controlled value (two DMARC clauses)', () => {
    expect(
      domain(
        'Authentication-Results: amazonses.com; spf=fail envelope-from=x@evil.example; ' +
          'helo=x;dmarc=pass header.from=example.com; dmarc=fail header.from=example.com;',
      ),
    ).toBeUndefined();
  });
});
