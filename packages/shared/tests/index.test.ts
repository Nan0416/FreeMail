import { describe, expect, it } from 'vitest';
import { FREEMAIL_VERSION, healthOk, isNonEmptyString } from '../src/index.js';

describe('shared', () => {
  it('reports ok health for a service', () => {
    expect(healthOk('svc')).toEqual({ status: 'ok', service: 'svc' });
  });

  it('detects non-empty strings', () => {
    expect(isNonEmptyString('x')).toBe(true);
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString(42)).toBe(false);
  });

  it('exposes a version', () => {
    expect(FREEMAIL_VERSION).toBe('0.0.0');
  });
});
