/**
 * Whether a received message's From domain is authenticated, as SES judged it. SES prepends its
 * own `Authentication-Results` header (authserv-id `amazonses.com`) above every header the
 * message arrived with, so only the FIRST occurrence is trusted and a header the sender supplied
 * can only come after it. This rests on the same premise as the scan verdicts: SES always
 * prepends its header for mail stored by the scan-enabled receipt rule. (If it ever didn't, a
 * sender-supplied first header would be read as SES's.)
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
 * clause, so a `; dmarc=pass …` could be smuggled in there. SES writes spf, then dkim, then
 * exactly one dmarc clause, last: a DMARC result that is not the single, final clause is
 * tampering (or SES wrote none), and fails closed.
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
  const clauses = parts.slice(1).filter((part) => part.trim() !== '');
  const dmarc = clauses.filter((part) => DMARC_CLAUSE.test(part));
  const last = clauses[clauses.length - 1];
  if (dmarc.length !== 1 || last === undefined || !DMARC_CLAUSE.test(last)) {
    return undefined;
  }
  const match = DMARC_PASS.exec(last);
  return match?.[1]?.toLowerCase();
}
