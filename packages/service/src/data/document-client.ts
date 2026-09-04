/**
 * The one DynamoDB document client per execution environment.
 *
 * A client owns a connection pool, so every DAO in a Lambda shares this one instance — the
 * dependency factories build it once and inject it, which is why the DAOs take a client
 * rather than constructing their own.
 *
 * `removeUndefinedValues` is load-bearing, not a nicety: several rows are written with
 * optional attributes left `undefined`, which the marshaller rejects outright otherwise.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Build the shared client. The region is resolved by the SDK from the execution
 * environment (`AWS_REGION`, which Lambda always sets) rather than from deploy config —
 * FreeMail makes no cross-region call, so pinning it would only add a way to be wrong.
 */
export function createDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}
