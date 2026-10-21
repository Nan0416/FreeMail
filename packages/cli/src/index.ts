#!/usr/bin/env node
/**
 * `freemail` CLI entry point.
 *
 * `version`/`validate`/`help` are handled synchronously by `main`. `init` runs an
 * interactive flow, so it's dispatched separately (and lazily imports the
 * prompt/AWS deps so simple commands stay fast).
 *
 * The installed `freemail` bin is `bin/freemail.js`, which calls `run`; running this file
 * directly (`node dist/index.js`, `npm start`) runs it too.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FREEMAIL_VERSION } from '@freemail/shared';
import { runValidate } from './validate.js';

const HELP = `freemail ${FREEMAIL_VERSION}
Usage: freemail <command>

  init      Configure FreeMail for deployment (writes freemail-config.json)
  validate  Check freemail-config.json the way cdk deploy will read it
  version   Print the CLI version
`;

export function main(argv: string[] = process.argv.slice(2)): number {
  const command = argv[0] ?? 'help';
  switch (command) {
    case 'version':
      process.stdout.write(`freemail ${FREEMAIL_VERSION}\n`);
      return 0;
    case 'validate':
      return runValidate({
        log: (message) => process.stdout.write(`${message}\n`),
        error: (message) => process.stderr.write(`${message}\n`),
      });
    default:
      process.stdout.write(HELP);
      return 0;
  }
}

async function runInitCommand(): Promise<void> {
  try {
    const [initModule, promptsModule] = await Promise.all([
      import('./init.js'),
      import('./prompts.js'),
    ]);
    process.exit(await initModule.runInit(promptsModule.createInitIo()));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/** Run the CLI with the arguments after `freemail`. */
export function run(argv: string[]): void {
  if (argv[0] === 'init') {
    void runInitCommand();
  } else {
    process.exit(main(argv));
  }
}

/**
 * Whether this module is the script node was asked to run. A path to it may go through
 * symlinks (a workspace link, or macOS's `/tmp` → `/private/tmp`) while `import.meta.url` is
 * the resolved file, so compare real paths.
 */
export function isEntryPoint(scriptPath: string | undefined, moduleUrl: string): boolean {
  if (!scriptPath) {
    return false;
  }
  try {
    return realpathSync(scriptPath) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

// Run only when invoked directly (not when imported by the bin or by tests).
if (isEntryPoint(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2));
}
