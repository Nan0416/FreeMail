import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { optionalSubjectFromContext, schemeFromContext } from '../../src/utils/request-context.js';

function eventWith(lambda: Record<string, unknown> | undefined): APIGatewayProxyEventV2 {
  return {
    requestContext: { authorizer: lambda ? { lambda } : undefined },
  } as unknown as APIGatewayProxyEventV2;
}

describe('optionalSubjectFromContext', () => {
  it('returns the subject when the authorizer attached one', () => {
    expect(optionalSubjectFromContext(eventWith({ sub: 'owner', scheme: 'access' }))).toBe('owner');
  });

  it.each([
    ['no authorizer context at all (a public route)', undefined],
    ['a context with no subject', { scheme: 'access' }],
    ['a non-string subject', { sub: 42 }],
  ])('returns undefined for %s, without throwing', (_label, lambda) => {
    expect(optionalSubjectFromContext(eventWith(lambda))).toBeUndefined();
  });
});

describe('schemeFromContext', () => {
  it('returns the scheme, or undefined when absent', () => {
    expect(schemeFromContext(eventWith({ sub: 'owner', scheme: 'apiKey' }))).toBe('apiKey');
    expect(schemeFromContext(eventWith({ sub: 'owner' }))).toBeUndefined();
    expect(schemeFromContext(eventWith(undefined))).toBeUndefined();
  });
});
