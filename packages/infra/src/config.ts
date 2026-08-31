import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFreeMailConfig } from '@freemail/shared/config';
import type { FreeMailConfig } from '@freemail/shared/config';

/**
 * The deploy config has exactly ONE location: `freemail-config.json` at the repo root,
 * written by `freemail init` and gitignored (it names your domains and zone).
 * `freemail-config.template.json` beside it is the committed starting point.
 *
 * Deliberately not configurable. It used to be resolvable from three places — a
 * `-c configPath=` CDK context value, a `FREEMAIL_CONFIG` env var, then a default —
 * which meant answering "which config did this deploy actually use?" required checking
 * three sources in precedence order. One fixed path is one answer.
 */
export const CONFIG_FILENAME = 'freemail-config.json';

/** Absolute path to the repo-root config file. */
export function configPath(): string {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return join(repoRoot, CONFIG_FILENAME);
}

/** Read, JSON-parse, and validate the FreeMail deploy config, failing loud. */
export function loadConfig(path: string = configPath()): FreeMailConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `FreeMail: no config found at ${path}. Run \`npx freemail init\` to create one, ` +
        `or copy ${CONFIG_FILENAME.replace('.json', '.template.json')} and fill it in.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`FreeMail: config at ${path} is not valid JSON: ${(error as Error).message}`);
  }

  return parseFreeMailConfig(json);
}
