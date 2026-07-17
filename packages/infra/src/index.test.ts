import { describe, expect, it } from 'vitest';
import { INFRA_PLACEHOLDER } from './index.js';

describe('infra', () => {
  it('exposes a placeholder identifier', () => {
    expect(INFRA_PLACEHOLDER).toContain('freemail-infra');
  });
});
