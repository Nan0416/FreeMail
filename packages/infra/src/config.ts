import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFreeMailConfig } from '@freemail/shared';
import type { FreeMailConfig } from '@freemail/shared';

export interface ConfigPathOptions {
  /** `-c configPath=...` CDK context value, if provided. */
  readonly contextPath?: unknown;
  /** `FREEMAIL_CONFIG` environment override, if set. */
  readonly envPath?: string;
  /** Fallback path when neither context nor env is provided. */
  readonly defaultPath: string;
}

/** Resolve the config file path from CDK context, then env, then the default. */
export function resolveConfigPath({
  contextPath,
  envPath,
  defaultPath,
}: ConfigPathOptions): string {
  if (typeof contextPath === 'string' && contextPath.length > 0) {
    return resolve(contextPath);
  }
  if (envPath && envPath.length > 0) {
    return resolve(envPath);
  }
  return defaultPath;
}

/** Read, JSON-parse, and validate the FreeMail config at `configPath`, failing loud. */
export function loadConfig(configPath: string): FreeMailConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(
      `FreeMail: no config found at ${configPath}. Run \`freemail init\` to create one.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `FreeMail: config at ${configPath} is not valid JSON: ${(error as Error).message}`,
    );
  }

  return parseFreeMailConfig(json);
}
