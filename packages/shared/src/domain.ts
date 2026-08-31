/**
 * Pure domain-name helpers, shared by the deploy config (which validates that every
 * configured host sits inside the hosted zone) and the service (which validates that a
 * send's from-address is under the email domain).
 *
 * Kept out of `config.ts` deliberately: these are app-level and dependency-free, so the
 * browser bundle can import them from the barrel without pulling in the deploy config's
 * zod schema.
 */

/** Canonicalize a domain: trim, lowercase, drop a trailing dot (DNS is case-insensitive). */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/** True when `domain` equals `parent` or is a subdomain of it. Both should be normalized first. */
export function isSubdomainOrEqual(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}
