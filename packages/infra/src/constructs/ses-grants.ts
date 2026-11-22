import { Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';

/**
 * Let a function send mail From the email domain (SES domain identities cover subdomains too).
 * `SendEmail` with raw content also authorizes `SendRawEmail`. Shared by the REST send route,
 * the MCP server and the forwarder.
 *
 * BOTH the identity and the configuration-set ARN are required. Every sender passes
 * `ConfigurationSetName` (that is how suppression and bounce/complaint events keep working in
 * sesIdentity `import` mode), and SES authorizes such a send against the configuration-set
 * resource as well as the identity. Granting the identity alone fails at runtime, not at deploy,
 * with a 403 AccessDeniedException naming the configuration set.
 *
 * `fromAddress` narrows the grant to that one sender (`ses:FromAddress`, which SES takes from the
 * request's `FromEmailAddress`): the forwarder only ever sends From `forwarding@<domain>`.
 */
export function grantSesSend(fn: IFunction, emailDomain: string, configurationSetName: string, options: { readonly fromAddress?: string } = {}): void {
  const stack = Stack.of(fn);
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: [
        stack.formatArn({ service: 'ses', resource: 'identity', resourceName: emailDomain }),
        stack.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: configurationSetName }),
      ],
      ...(options.fromAddress !== undefined ? { conditions: { StringEquals: { 'ses:FromAddress': options.fromAddress } } } : {}),
    }),
  );
}
