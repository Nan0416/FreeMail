import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { loadConfig, resolveConfigPath } from './config.js';
import { FreeMailStack } from './freemail-stack.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const app = new App();
const configPath = resolveConfigPath({
  contextPath: app.node.tryGetContext('configPath'),
  envPath: process.env.FREEMAIL_CONFIG,
  defaultPath: join(repoRoot, 'freemail.config.json'),
});

new FreeMailStack(app, 'FreeMailStack', { config: loadConfig(configPath) });
