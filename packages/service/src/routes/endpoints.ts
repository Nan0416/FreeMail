import type { Express } from 'express';

/**
 * One domain's slice of the route table. `FreeMailService` binds each registered
 * `Endpoints` into the app, so adding a surface is adding a class and one line in
 * `handlers/service-handler.ts`.
 */
export interface Endpoints {
  bind(app: Express): void;
}
