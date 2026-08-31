import { App } from 'aws-cdk-lib';
import { loadConfig } from './config.js';
import { FreeMailStack } from './freemail-stack.js';

const app = new App();

new FreeMailStack(app, 'FreeMailStack', { config: loadConfig() });
