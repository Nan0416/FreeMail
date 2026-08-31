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
import { DEFAULT_REGION, parseFreeMailConfig } from '@freemail/shared/config';
import type { FreeMailConfig, HostedZoneConfig } from '@freemail/shared/config';

export const CONFIG_FILENAME = 'freemail-config.json';

export interface InitAnswers {
  readonly hostedZone: HostedZoneConfig;
  readonly emailDomain: string;
  /** Domain the web app is served at. Required as of #47 (no CloudFront default). */
  readonly appDomain: string;
  /** Domain the API is served at. Required as of #47 (no execute-api default). */
  readonly apiDomain: string;
  readonly inboundEnabled: boolean;
  /** Whether the deployer acknowledged the MX-override warning. */
  readonly inboundConfirmed: boolean;
}

/** Build a validated config from gathered answers. Inbound ships only when acknowledged. */
export function buildConfig(answers: InitAnswers): FreeMailConfig {
  const inboundEnabled = answers.inboundEnabled && answers.inboundConfirmed;
  return parseFreeMailConfig({
    region: DEFAULT_REGION,
    hostedZone: answers.hostedZone,
    emailDomain: answers.emailDomain,
    appDomain: answers.appDomain,
    apiDomain: answers.apiDomain,
    inbound: { enabled: inboundEnabled, confirmInboundMx: inboundEnabled },
  });
}

export async function writeConfig(path: string, config: FreeMailConfig): Promise<void> {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export interface InitIo {
  readonly prompt: () => Promise<InitAnswers>;
  readonly fileExists: (path: string) => boolean;
  readonly confirmOverwrite: (path: string) => Promise<boolean>;
  readonly write: (path: string, config: FreeMailConfig) => Promise<void>;
  readonly log: (message: string) => void;
}

/**
 * Orchestrate the init flow. Returns a process exit code.
 *
 * The output path is fixed: the CDK app reads exactly one file, so an `--out` override
 * could only ever produce a config the deploy cannot find.
 */
export async function runInit(io: InitIo): Promise<number> {
  const outPath = resolve(CONFIG_FILENAME);
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
