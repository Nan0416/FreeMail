/**
 * `freemail validate` — check `freemail-config.json` without synthesizing the stack.
 *
 * It loads the file through `loadFreeMailConfig`, the loader the CDK app uses at synth, so
 * a config that passes here is one `cdk deploy` can load. It checks the file only: it makes
 * no AWS calls, so it cannot tell whether the hosted zone or SES identity it names exist.
 */
import { configPath, loadFreeMailConfig } from '@freemail/shared/config';

export interface ValidateIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

/** Validate the repo-root config, the file `cdk deploy` reads. Returns a process exit code. */
export function runValidate(io: ValidateIo, path: string = configPath()): number {
  try {
    loadFreeMailConfig(path);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  io.log(`${path} is a valid FreeMail config.`);
  return 0;
}
