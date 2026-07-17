import { describe, expect, it } from 'vitest';
import { serviceHealth } from './index.js';

describe('service', () => {
  it('returns ok health', () => {
    expect(serviceHealth().status).toBe('ok');
  });
});
