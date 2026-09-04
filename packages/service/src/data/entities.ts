/**
 * The DynamoDB key schema for every FreeMail table, in one module.
 *
 * This is what conduit's `data/entities.ts` is FOR — one place that answers "how is this
 * row addressed?", so a key is never spelled out twice and a reader can see the whole
 * layout without opening four DAOs. Conduit expresses it through ElectroDB entities;
 * FreeMail keeps the raw commands, because its `ConditionExpression`s ARE its concurrency
 * safety (the trust-on-first-use enrollment race, the atomic download-token claim, the
 * lockout compare-and-swap) and each has a test pinning that exact semantics. So this is
 * the schema half of an entity definition without the query builder on top.
 *
 * NOTHING here talks to AWS. It is pure key construction, so a DAO test can assert the
 * exact key a command was issued against.
 */
import { INBOUND_PARTITION, SENT_PARTITION } from './emails-dao.js';

/** A full DynamoDB primary key for the single-table auth and emails layouts. */
export interface TableKey {
  readonly pk: string;
  readonly sk: string;
}

/**
 * Auth table — one partition of singleton rows (`pk:'auth'`) plus one row per live refresh
 * token. The singletons are why the table is a compare-and-swap target rather than an
 * append log: there is exactly one password, one signing key, one lockout counter.
 */
export const AuthEntity = {
  PARTITION: 'auth',
  REFRESH_PARTITION: 'refresh',
  /** The enrolled password hash (written once, under `attribute_not_exists`). */
  password: (): TableKey => ({ pk: 'auth', sk: 'password' }),
  /** The persisted HS256 signing key (claimed once, by whichever cold start wins). */
  signingKey: (): TableKey => ({ pk: 'auth', sk: 'signing-key' }),
  /** Lockout counters, advanced by a versioned CAS so parallel failures cannot be lost. */
  lockout: (): TableKey => ({ pk: 'auth', sk: 'lockout' }),
  /** One live refresh token, addressed by its hash — the raw token is never stored. */
  refreshToken: (tokenHash: string): TableKey => ({ pk: 'refresh', sk: tokenHash }),
} as const;

/** API keys table — keyed by the public half of the key; the secret is only ever a hash. */
export const ApiKeyEntity = {
  key: (keyId: string): { readonly keyId: string } => ({ keyId }),
} as const;

/**
 * Emails table — two partitions, each sorted newest-first by a timestamp-prefixed sort key.
 * The `<iso>#<id>` shape is load-bearing: ISO-8601 UTC is fixed-width and sorts
 * chronologically as a string, so a descending Query is a reverse-chronological timeline,
 * and the `#<id>` suffix keeps two messages in the same millisecond distinct.
 */
export const EmailEntity = {
  SENT_PARTITION,
  INBOUND_PARTITION,
  partitionFor: (direction: 'sent' | 'inbound'): string =>
    direction === 'sent' ? SENT_PARTITION : INBOUND_PARTITION,
  sent: (sentAtIso: string, id: string): TableKey => ({
    pk: SENT_PARTITION,
    sk: `${sentAtIso}#${id}`,
  }),
  inbound: (receivedAtIso: string, id: string): TableKey => ({
    pk: INBOUND_PARTITION,
    sk: `${receivedAtIso}#${id}`,
  }),
} as const;

/** Download tokens table — keyed by the token itself, which IS the capability. */
export const DownloadTokenEntity = {
  key: (token: string): { readonly token: string } => ({ token }),
} as const;

/** DynamoDB's error name for a failed `ConditionExpression`. */
export const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

/** True when a write failed because its `ConditionExpression` did not hold. */
export function isConditionalCheckFailed(error: unknown): boolean {
  return (error as { name?: string })?.name === CONDITIONAL_CHECK_FAILED;
}
