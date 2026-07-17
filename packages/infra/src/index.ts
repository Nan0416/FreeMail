/**
 * FreeMail infrastructure (AWS CDK) — public surface for the CDK app entry
 * (`app.ts`) and for tests.
 */
export { FreeMailStack } from './freemail-stack.js';
export type { FreeMailStackProps } from './freemail-stack.js';
export { DnsConstruct } from './constructs/dns.js';
export type { DnsConstructProps } from './constructs/dns.js';
export { DataConstruct } from './constructs/data.js';
export { loadConfig, resolveConfigPath } from './config.js';
export type { ConfigPathOptions } from './config.js';
