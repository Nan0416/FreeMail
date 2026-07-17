/**
 * `freemail init` — gather deploy answers, build a validated `FreeMailConfig`,
 * and write it to disk for the CDK app to read.
 *
 * The interactive prompting (`@inquirer/prompts`) and Route53 lookups live in
 * `prompts.ts`; this module holds the pure config-building + orchestration so it
 * is unit-testable with an injected `InitIo`.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_REGION, parseFreeMailConfig } from '@freemail/shared';
import type { FreeMailConfig, HostedZoneConfig } from '@freemail/shared';

export const DEFAULT_CONFIG_FILENAME = 'freemail.config.json';

export interface InitAnswers {
  hostedZone: HostedZoneConfig;
  emailDomain: string;
  appDomain?: string;
  apiDomain?: string;
  inboundEnabled: boolean;
  /** Whether the deployer acknowledged the MX-override warning. */
  inboundConfirmed: boolean;
}

/** Build a validated config from gathered answers. Inbound ships only when acknowledged. */
export function buildConfig(answers: InitAnswers): FreeMailConfig {
  const inboundEnabled = answers.inboundEnabled && answers.inboundConfirmed;
  return parseFreeMailConfig({
    region: DEFAULT_REGION,
    hostedZone: answers.hostedZone,
    emailDomain: answers.emailDomain,
    ...(answers.appDomain ? { appDomain: answers.appDomain } : {}),
    ...(answers.apiDomain ? { apiDomain: answers.apiDomain } : {}),
    inbound: { enabled: inboundEnabled, confirmInboundMx: inboundEnabled },
  });
}

export async function writeConfig(path: string, config: FreeMailConfig): Promise<void> {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** Extract `--out <path>` / `--out=<path>` / `-o <path>` from the argv, if present. */
export function parseOutArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--out' || arg === '-o') && argv[i + 1]) {
      return argv[i + 1];
    }
    if (arg.startsWith('--out=')) {
      return arg.slice('--out='.length);
    }
  }
  return undefined;
}

export interface InitIo {
  prompt: () => Promise<InitAnswers>;
  fileExists: (path: string) => boolean;
  confirmOverwrite: (path: string) => Promise<boolean>;
  write: (path: string, config: FreeMailConfig) => Promise<void>;
  log: (message: string) => void;
}

/** Orchestrate the init flow. Returns a process exit code. */
export async function runInit(argv: string[], io: InitIo): Promise<number> {
  const outPath = resolve(parseOutArg(argv) ?? DEFAULT_CONFIG_FILENAME);
  const answers = await io.prompt();
  const config = buildConfig(answers);

  if (io.fileExists(outPath) && !(await io.confirmOverwrite(outPath))) {
    io.log('Aborted — existing config left unchanged.');
    return 1;
  }

  await io.write(outPath, config);
  io.log(
    [
      ``,
      `Wrote ${outPath}`,
      ``,
      `Next steps:`,
      `  cd packages/infra`,
      `  npx cdk bootstrap   # first time in this account/region`,
      `  npx cdk deploy`,
      ``,
    ].join('\n'),
  );
  return 0;
}
