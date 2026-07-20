import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/errors.js';
import {
  requireAccessScheme,
  schemeFromContext,
  subjectFromContext,
} from '../../src/handlers/request-context.js';

function eventWith(lambda: Record<string, unknown> | undefined): APIGatewayProxyEventV2 {
  return {
    requestContext: { authorizer: lambda ? { lambda } : undefined },
  } as unknown as APIGatewayProxyEventV2;
}

describe('subjectFromContext', () => {
  it('returns the authenticated subject', () => {
    expect(subjectFromContext(eventWith({ sub: 'owner', scheme: 'access' }))).toBe('owner');
  });

  it('throws invalid_token when the subject is missing', () => {
    const error = (() => {
      try {
        subjectFromContext(eventWith({ scheme: 'access' }));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('invalid_token');
  });
});

describe('schemeFromContext', () => {
  it('returns the scheme, or undefined when absent', () => {
    expect(schemeFromContext(eventWith({ sub: 'owner', scheme: 'apiKey' }))).toBe('apiKey');
    expect(schemeFromContext(eventWith({ sub: 'owner' }))).toBeUndefined();
    expect(schemeFromContext(eventWith(undefined))).toBeUndefined();
  });
});

describe('requireAccessScheme', () => {
  it('allows an access-token caller', () => {
    expect(() => requireAccessScheme(eventWith({ sub: 'owner', scheme: 'access' }))).not.toThrow();
  });

  it.each([
    ['an API key', { sub: 'owner', scheme: 'apiKey' }],
    ['a missing scheme (fails closed)', { sub: 'owner' }],
  ])('forbids %s from managing keys', (_label, lambda) => {
    const error = (() => {
      try {
        requireAccessScheme(eventWith(lambda));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('forbidden');
    expect((error as AuthError).status).toBe(403);
  });
});
