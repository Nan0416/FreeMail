/**
 * FreeMail infrastructure (AWS CDK) — public surface for the CDK app entry
 * (`app.ts`) and for tests.
 */
export { FreeMailStack } from './freemail-stack.js';
export type { FreeMailStackProps } from './freemail-stack.js';
export { DnsConstruct } from './constructs/dns.js';
export type { DnsConstructProps } from './constructs/dns.js';
export { DataConstruct } from './constructs/data.js';
export { SesConstruct } from './constructs/ses.js';
export type { SesConstructProps } from './constructs/ses.js';
export { CONFIG_FILENAME, configPath, loadConfig } from './config.js';
