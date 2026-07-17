/**
 * Normalizing SES scan verdicts and deciding content exposure — fail closed. The
 * ONLY affirmative-clean value is `PASS`: a missing header (`ABSENT`), a
 * duplicated/injected header (`CONFLICTING`), or an unrecognized token (`UNKNOWN`)
 * is treated exactly like `FAIL`/`GRAY`/`PROCESSING_FAILED` — no attachment
 * extraction, no snippet/body. Absence of an affirmative PASS is not-clean.
 */
import type { HeaderLine } from './headers.js';
import { headerValues } from './headers.js';
import type { InboundParseStatus, InboundVerdict } from '../data/emails-repo.js';

const SPAM_HEADER = 'x-ses-spam-verdict';
const VIRUS_HEADER = 'x-ses-virus-verdict';

const KNOWN_VERDICTS: ReadonlySet<string> = new Set(['PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED']);

/**
 * The verdict for one SES header from the ordered raw header lines. First occurrence
 * wins (SES prepends its own); more than one occurrence is tampering → `CONFLICTING`.
 */
export function verdictFromHeaders(lines: readonly HeaderLine[], header: string): InboundVerdict {
  const values = headerValues(lines, header);
  if (values.length === 0) return 'ABSENT';
  if (values.length > 1) return 'CONFLICTING';
  const token = values[0].trim().toUpperCase();
  return KNOWN_VERDICTS.has(token) ? (token as InboundVerdict) : 'UNKNOWN';
}

export interface Verdicts {
  spamVerdict: InboundVerdict;
  virusVerdict: InboundVerdict;
}

/** Extract both SES verdicts from the raw header lines. */
export function extractVerdicts(lines: readonly HeaderLine[]): Verdicts {
  return {
    spamVerdict: verdictFromHeaders(lines, SPAM_HEADER),
    virusVerdict: verdictFromHeaders(lines, VIRUS_HEADER),
  };
}

export interface Exposure {
  /** Extract attachments + store a snippet/body. True only for a parsed, virus-`PASS` message. */
  exposeContent: boolean;
  /** Hide by default: content suppressed for any reason, OR spam-flagged. */
  quarantined: boolean;
}

/**
 * The single fail-closed gate. Content is exposed only when parsing fully succeeded
 * AND the virus verdict is an affirmative `PASS`. Spam is orthogonal: it only forces
 * `quarantined` (hidden by default) — a virus-`PASS`, spam-`FAIL` message is still
 * extracted and previewable, just hidden until the reader opts in.
 */
export function decideExposure(verdicts: Verdicts, parseStatus: InboundParseStatus): Exposure {
  const exposeContent = parseStatus === 'ok' && verdicts.virusVerdict === 'PASS';
  const quarantined = !exposeContent || verdicts.spamVerdict === 'FAIL';
  return { exposeContent, quarantined };
}
