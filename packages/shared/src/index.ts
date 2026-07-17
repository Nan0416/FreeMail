/**
 * Shared types and utilities for FreeMail.
 *
 * Domain types and helpers are added here as features land (issues #2+). For now
 * this establishes the package and exercises the project-reference wiring.
 */

export const FREEMAIL_VERSION = '0.0.0';

export type HealthStatus = 'ok' | 'degraded';

export interface HealthReport {
  status: HealthStatus;
  service: string;
}

export function healthOk(service: string): HealthReport {
  return { status: 'ok', service };
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
