#!/usr/bin/env node
// The `freemail` bin. It is committed rather than built so that `npm install` links it on a
// fresh clone: npm skips a bin whose file doesn't exist yet, and dist/ only appears after
// `npm run build`.
let cli;
try {
  cli = await import('../dist/index.js');
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(
      `The FreeMail CLI is not built yet. Run \`npm run build\` at the repo root, then retry.\n(${error.message})\n`,
    );
    process.exit(1);
  }
  throw error;
}
cli.run(process.argv.slice(2));
