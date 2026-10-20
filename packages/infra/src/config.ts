import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, loadFreeMailConfig } from '@freemail/shared/config';
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
export { CONFIG_FILENAME };

/** Absolute path to the repo-root config file. */
export function configPath(): string {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return join(repoRoot, CONFIG_FILENAME);
}

/** Read, JSON-parse, and validate the FreeMail deploy config, failing loud. */
export function loadConfig(path: string = configPath()): FreeMailConfig {
  return loadFreeMailConfig(path);
}
