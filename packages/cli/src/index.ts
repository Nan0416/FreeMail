#!/usr/bin/env node
/**
 * `freemail` CLI entry point.
 *
 * The `freemail init` deploy-question flow lands in issue #2. For now this is a
 * placeholder so the bin wiring is exercised.
 */
import { FREEMAIL_VERSION } from '@freemail/shared';

const HELP = `freemail ${FREEMAIL_VERSION}
Usage: freemail <command>

  version   Print the CLI version
  init      Configure and deploy FreeMail (coming in #2)
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

// Run only when invoked directly as the CLI (not when imported by tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
