/**
 * Whether a received message's From domain is authenticated, as SES judged it. SES prepends its
 * own `Authentication-Results` header (authserv-id `amazonses.com`) above every header the
 * message arrived with, so only the FIRST occurrence is trusted — like the scan verdicts. A
 * header the sender supplied can only come after it, and one claiming to be SES's but sitting
 * first means SES added none: either way it is never read as SES's result.
 */
import type { HeaderLine } from './inbound-headers.js';
import { headerValues } from './inbound-headers.js';

const AUTH_RESULTS_HEADER = 'authentication-results';
const SES_AUTHSERV_ID = 'amazonses.com';
const DMARC_CLAUSE = /^\s*dmarc\s*=/i;
const DMARC_PASS = /^\s*dmarc\s*=\s*pass\b[^;]*?\bheader\.from\s*=\s*"?([A-Za-z0-9.-]+)"?/i;

/**
 * The From domain SES's DMARC check passed for (lowercased), or undefined when SES's header is
 * missing or reports anything but `dmarc=pass`. DMARC binds the From header's domain to an
 * aligned SPF or DKIM pass, so a pass means the From domain was not spoofed.
 *
 * SES's header echoes values the sender controls (the HELO name, the envelope sender) in its SPF
 * clause, so a `; dmarc=pass …` could be smuggled in there. SES writes exactly one DMARC clause:
 * more than one is tampering, and fails closed.
 */
export function dmarcPassDomain(lines: readonly HeaderLine[]): string | undefined {
  const first = headerValues(lines, AUTH_RESULTS_HEADER)[0];
  if (first === undefined) {
    return undefined;
  }
  const parts = first.split(';');
  if ((parts[0] ?? '').trim().toLowerCase() !== SES_AUTHSERV_ID) {
    return undefined;
  }
  const dmarc = parts.slice(1).filter((part) => DMARC_CLAUSE.test(part));
  if (dmarc.length !== 1) {
    return undefined;
  }
  const match = DMARC_PASS.exec(dmarc[0] ?? '');
  return match?.[1]?.toLowerCase();
}
