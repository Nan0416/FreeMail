import { afterEach, describe, expect, it } from 'vitest';
import {
  getServiceConfig,
  readServiceConfig,
  resetServiceConfigCache,
} from '../../src/handlers/service-config.js';

const COMPLETE: NodeJS.ProcessEnv = {
  AUTH_TABLE: 'auth',
  API_KEYS_TABLE: 'keys',
  EMAILS_TABLE: 'emails',
  DOWNLOAD_TOKENS_TABLE: 'tokens',
  MAIL_BUCKET: 'bucket',
  QUARANTINE_BUCKET: 'quarantine',
  EMAIL_DOMAIN: 'example.com',
  DOWNLOAD_BASE_URL: 'https://api.example.com',
};

afterEach(() => {
  resetServiceConfigCache();
});

describe('readServiceConfig', () => {
  it('maps the environment onto the camel-cased config', () => {
    expect(readServiceConfig({ ...COMPLETE, SES_CONFIGURATION_SET: 'cfg' })).toEqual({
      authTable: 'auth',
      apiKeysTable: 'keys',
      emailsTable: 'emails',
      downloadTokensTable: 'tokens',
      mailBucket: 'bucket',
      quarantineBucket: 'quarantine',
      emailDomain: 'example.com',
      downloadBaseUrl: 'https://api.example.com',
      sesConfigurationSet: 'cfg',
    });
  });

  it('treats the SES configuration set as optional', () => {
    expect(readServiceConfig(COMPLETE).sesConfigurationSet).toBeUndefined();
  });

  it('reads the optional attachment embed limits as byte counts', () => {
    const config = readServiceConfig({
      ...COMPLETE,
      EMBED_MAX_BYTES: '1048576',
      EMBED_TOTAL_BYTES: '5242880',
    });
    expect(config.embedMaxBytes).toBe(1048576);
    expect(config.embedTotalBytes).toBe(5242880);
    expect(readServiceConfig(COMPLETE).embedMaxBytes).toBeUndefined();
  });

  it.each(['0', '-1', '1.5', '3MB'])('rejects an embed limit of %s', (value) => {
    expect(() => readServiceConfig({ ...COMPLETE, EMBED_MAX_BYTES: value })).toThrow(
      /EMBED_MAX_BYTES/,
    );
  });

  it('names EVERY missing variable in one error, not just the first', () => {
    const partial = { ...COMPLETE };
    delete partial.AUTH_TABLE;
    delete partial.MAIL_BUCKET;
    delete partial.EMAILS_TABLE;

    expect(() => readServiceConfig(partial)).toThrow(/AUTH_TABLE, EMAILS_TABLE, MAIL_BUCKET/);
  });

  it('treats an empty string as absent', () => {
    expect(() => readServiceConfig({ ...COMPLETE, EMAIL_DOMAIN: '' })).toThrow(/EMAIL_DOMAIN/);
  });
});

describe('getServiceConfig', () => {
  it('reads the environment once and reuses it for the life of the container', () => {
    Object.assign(process.env, COMPLETE);
    try {
      expect(getServiceConfig().authTable).toBe('auth');
      process.env.AUTH_TABLE = 'changed-under-a-running-lambda';
      expect(getServiceConfig().authTable).toBe('auth');

      resetServiceConfigCache();
      expect(getServiceConfig().authTable).toBe('changed-under-a-running-lambda');
    } finally {
      for (const key of Object.keys(COMPLETE)) {
        delete process.env[key];
      }
    }
  });
});
