/**
 * Interactive `freemail init` prompting (@inquirer/prompts) + the real `InitIo`
 * wiring. Kept out of `init.ts` so the orchestration there stays unit-testable
 * without driving a TTY.
 */
import { existsSync } from 'node:fs';
import { confirm, input, select } from '@inquirer/prompts';
import { isSubdomainOrEqual, normalizeDomain, type HostedZoneConfig } from '@freemail/shared';
import { type InitAnswers, type InitIo, writeConfig } from './init.js';
import { listHostedZones } from './route53.js';

const MANUAL_ENTRY = '__manual__';

function requireDomain(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Please enter a domain.';
  }
  if (/\s/.test(trimmed) || !trimmed.includes('.')) {
    return 'Enter a valid domain, e.g. example.com';
  }
  return true;
}

async function optionalInput(message: string): Promise<string | undefined> {
  const value = (await input({ message })).trim();
  return value.length > 0 ? value : undefined;
}

async function resolveHostedZone(): Promise<HostedZoneConfig> {
  const exists = await confirm({
    message: 'Do you already have a Route53 hosted zone for your domain?',
    default: true,
  });

  if (!exists) {
    const zoneName = normalizeDomain(
      await input({
        message: 'Domain to create a new Route53 hosted zone for (e.g. example.com):',
        validate: requireDomain,
      }),
    );
    return { mode: 'create', zoneName };
  }

  let zones: Awaited<ReturnType<typeof listHostedZones>> = [];
  try {
    zones = await listHostedZones();
  } catch {
    // No credentials / offline — fall back to manual entry below.
  }

  if (zones.length > 0) {
    const choice = await select({
      message: 'Select the hosted zone to use:',
      choices: [
        ...zones.map((zone) => ({ name: `${zone.name} (${zone.id})`, value: zone.id })),
        { name: 'Enter zone ID manually…', value: MANUAL_ENTRY },
      ],
    });
    if (choice !== MANUAL_ENTRY) {
      const zone = zones.find((z) => z.id === choice);
      if (zone) {
        return { mode: 'import', zoneName: normalizeDomain(zone.name), hostedZoneId: zone.id };
      }
    }
  }

  const zoneName = normalizeDomain(
    await input({
      message: 'Hosted zone domain (e.g. example.com):',
      validate: requireDomain,
    }),
  );
  const hostedZoneId = (
    await input({
      message: 'Hosted zone ID (e.g. Z0123456ABCDEF):',
      validate: (value) => (value.trim().length > 0 ? true : 'Please enter the hosted zone ID.'),
    })
  ).trim();
  return { mode: 'import', zoneName, hostedZoneId };
}

export async function promptAnswers(): Promise<InitAnswers> {
  const hostedZone = await resolveHostedZone();

  const emailDomain = normalizeDomain(
    await input({
      message: `Email domain — the zone apex or a subdomain (e.g. mail.${hostedZone.zoneName}):`,
      default: hostedZone.zoneName,
      validate: (value) =>
        isSubdomainOrEqual(normalizeDomain(value), hostedZone.zoneName) ||
        `Must be ${hostedZone.zoneName} or a subdomain of it.`,
    }),
  );

  const appDomain = await optionalInput(
    'Custom domain for the web app (optional; blank = CloudFront default):',
  );
  const apiDomain = await optionalInput(
    'Custom domain for the API (optional; blank = API Gateway default):',
  );

  const inboundEnabled = await confirm({
    message: 'Enable inbound email (receiving)? Off by default.',
    default: false,
  });

  let inboundConfirmed = false;
  if (inboundEnabled) {
    process.stdout.write(
      `\n  ⚠  Enabling inbound sets the MX record for "${emailDomain}" to AWS SES, overriding any existing\n` +
        `     mail routing for that domain. Use a dedicated subdomain (e.g. mail.${hostedZone.zoneName}) to\n` +
        `     avoid clobbering email you already receive.\n\n`,
    );
    inboundConfirmed = await confirm({
      message: `Point the MX record for "${emailDomain}" at SES and enable inbound?`,
      default: false,
    });
  }

  return { hostedZone, emailDomain, appDomain, apiDomain, inboundEnabled, inboundConfirmed };
}

export function confirmOverwrite(path: string): Promise<boolean> {
  return confirm({ message: `${path} already exists. Overwrite it?`, default: false });
}

/** The production `InitIo`: real prompts, filesystem, and stdout. */
export function createInitIo(): InitIo {
  return {
    prompt: promptAnswers,
    fileExists: existsSync,
    confirmOverwrite,
    write: writeConfig,
    log: (message) => process.stdout.write(message.endsWith('\n') ? message : `${message}\n`),
  };
}
