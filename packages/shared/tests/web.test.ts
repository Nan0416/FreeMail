import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, parseWebRuntimeConfig } from '../src/web.js';

describe('normalizeBaseUrl', () => {
  it('trims whitespace and strips trailing slashes', () => {
    expect(normalizeBaseUrl('  https://api.example.com/  ')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com///')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com');
  });
});

describe('parseWebRuntimeConfig', () => {
  it('accepts and normalizes a valid config, defaulting inboundEnabled to false', () => {
    expect(parseWebRuntimeConfig({ apiBaseUrl: 'https://api.example.com/' })).toEqual({
      apiBaseUrl: 'https://api.example.com',
      inboundEnabled: false,
    });
  });

  it('carries inboundEnabled through when present', () => {
    expect(
      parseWebRuntimeConfig({ apiBaseUrl: 'https://api.example.com', inboundEnabled: true }),
    ).toEqual({ apiBaseUrl: 'https://api.example.com', inboundEnabled: true });
    expect(
      parseWebRuntimeConfig({ apiBaseUrl: 'https://api.example.com', inboundEnabled: false }),
    ).toEqual({ apiBaseUrl: 'https://api.example.com', inboundEnabled: false });
  });

  it('fails loud on a non-boolean inboundEnabled (no silent coercion)', () => {
    expect(() =>
      parseWebRuntimeConfig({ apiBaseUrl: 'https://api.example.com', inboundEnabled: 'yes' }),
    ).toThrow(/"inboundEnabled" must be a boolean/);
    expect(() =>
      parseWebRuntimeConfig({ apiBaseUrl: 'https://api.example.com', inboundEnabled: 1 }),
    ).toThrow(/"inboundEnabled" must be a boolean/);
  });

  it('throws on a non-object', () => {
    expect(() => parseWebRuntimeConfig(null)).toThrow(/expected a JSON object/);
    expect(() => parseWebRuntimeConfig('https://x')).toThrow(/expected a JSON object/);
    expect(() => parseWebRuntimeConfig(['https://x'])).toThrow(/expected a JSON object/);
  });

  it('throws on a missing or empty apiBaseUrl (fail-loud, no silent default)', () => {
    expect(() => parseWebRuntimeConfig({})).toThrow(/"apiBaseUrl" must be a non-empty string/);
    expect(() => parseWebRuntimeConfig({ apiBaseUrl: '' })).toThrow(/non-empty string/);
    expect(() => parseWebRuntimeConfig({ apiBaseUrl: '   ' })).toThrow(/non-empty string/);
    expect(() => parseWebRuntimeConfig({ apiBaseUrl: 42 })).toThrow(/non-empty string/);
  });
});
