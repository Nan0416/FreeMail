#!/usr/bin/env node
/**
 * `freemail` CLI entry point.
 *
 * `version`/`help` are handled synchronously by `main`. `init` runs an
 * interactive flow, so it's dispatched separately (and lazily imports the
 * prompt/AWS deps so simple commands stay fast).
 */
import { FREEMAIL_VERSION } from '@freemail/shared';

const HELP = `freemail ${FREEMAIL_VERSION}
Usage: freemail <command>

  init      Configure FreeMail for deployment (writes freemail.config.json)
  version   Print the CLI version

init options:
  -o, --out <path>   Config output path (default: ./freemail.config.json)
`;

export function main(argv: string[] = process.argv.slice(2)): number {
  const command = argv[0] ?? 'help';
  switch (command) {
    case 'version':
      process.stdout.write(`freemail ${FREEMAIL_VERSION}\n`);
      return 0;
    default:
      process.stdout.write(HELP);
      return 0;
  }
}

async function runInitCommand(argv: string[]): Promise<void> {
  try {
    const [{ runInit }, { createInitIo }] = await Promise.all([
      import('./init.js'),
      import('./prompts.js'),
    ]);
    process.exit(await runInit(argv, createInitIo()));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

// Run only when invoked directly as the CLI (not when imported by tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'init') {
    void runInitCommand(argv.slice(1));
  } else {
    process.exit(main(argv));
  }
}
