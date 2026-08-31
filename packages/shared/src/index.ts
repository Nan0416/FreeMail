/**
 * Shared types and utilities for FreeMail — the APP surface, imported by the service,
 * the web SPA, the CDK app, and the CLI.
 *
 * The DEPLOY config (`./config`) is deliberately NOT re-exported here. It is only ever
 * read by the CDK app and written by the CLI, and its zod schema would otherwise be
 * pulled into the browser bundle through this barrel (measured: +64 kB raw / +17 kB
 * gzip) for a parser the SPA never calls. Import it as `@freemail/shared/config`.
 */

export const FREEMAIL_VERSION = '0.0.0';

export type HealthStatus = 'ok' | 'degraded';

export interface HealthReport {
  readonly status: HealthStatus;
  readonly service: string;
}

export function healthOk(service: string): HealthReport {
  return { status: 'ok', service };
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export * from './domain.js';
export * from './auth.js';
export * from './api-keys.js';
export * from './email.js';
export * from './web.js';
