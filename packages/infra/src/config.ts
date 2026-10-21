import { configPath, loadFreeMailConfig } from '@freemail/shared/config';
import type { FreeMailConfig } from '@freemail/shared/config';

export { CONFIG_FILENAME, configPath } from '@freemail/shared/config';

/** Read, JSON-parse, and validate the FreeMail deploy config, failing loud. */
export function loadConfig(path: string = configPath()): FreeMailConfig {
  return loadFreeMailConfig(path);
}
