/**
 * A minimal named console logger — the one logging seam for the service handlers.
 *
 * CloudWatch Logs is the only sink a Lambda has, so `console.*` IS the transport. This
 * wraps it so every line is uniformly stamped (`<iso8601> <LEVEL> [<name>] <message>`)
 * and so debug chatter can be silenced by level in a deployed stage.
 *
 * SECURITY — the message is composed by the caller, and it must NEVER contain the
 * request headers, the `Cookie` header (or even its name), a session/refresh token, or
 * an API key. FreeMail's session credentials ride in httpOnly cookies precisely so page
 * JS cannot read them; a log line that echoed a request would put a live session into
 * CloudWatch, where it is readable by anyone with log access. The
 * "never logs the Cookie header" case in `tests/handlers/service-handler.test.ts`
 * asserts this on the unhandled-error path — the one path that logs at all.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric ordering so a line is emitted only when its level meets the threshold. */
const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, error?: unknown): void;
  info(message: string, error?: unknown): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

function levelFromEnv(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

let threshold: LogLevel = levelFromEnv();

/** Override the threshold (tests, or a cold start that wants `LOG_LEVEL` re-read). */
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

class ConsoleLogger implements Logger {
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  debug(message: string, error?: unknown): void {
    this.emit('debug', message, error);
  }

  info(message: string, error?: unknown): void {
    this.emit('info', message, error);
  }

  warn(message: string, error?: unknown): void {
    this.emit('warn', message, error);
  }

  error(message: string, error?: unknown): void {
    this.emit('error', message, error);
  }

  private emit(level: LogLevel, message: string, error?: unknown): void {
    if (SEVERITY[level] < SEVERITY[threshold]) {
      return;
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${this.name}] ${message}`;
    // Resolved per call rather than captured at module load, so a test that spies on
    // `console.error` after import still observes the write.
    const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (error === undefined) {
      write(line);
    } else {
      write(line, error);
    }
  }
}

export function getLogger(name: string): Logger {
  return new ConsoleLogger(name);
}
