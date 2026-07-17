/**
 * HANDLED inbound-processing failures — the two cases that must NOT be retried.
 * A malformed message or a limit breach is attacker-controllable, so it produces a
 * bounded quarantined/parse-status row and a successful return, never an infinite
 * S3 retry. Every OTHER error (S3/DDB throttle or outage) is left to propagate so
 * the async invocation retries and eventually lands in the DLQ.
 */

/** The raw MIME could not be parsed (malformed / truncated / bad encoding). */
export class InboundParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundParseError';
  }
}

/** A resource limit was exceeded while parsing (size / count / parts). */
export class InboundLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundLimitError';
  }
}

/** True for the two handled classes — used by the processor to choose quarantine-vs-retry. */
export function isHandledInboundError(err: unknown): err is InboundParseError | InboundLimitError {
  return err instanceof InboundParseError || err instanceof InboundLimitError;
}
