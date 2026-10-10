/**
 * Agent API-key management: mint (shown raw exactly once), list summaries, revoke.
 *
 * Every route is `requireAccessScheme`-guarded. An `x-api-key` caller is authenticated,
 * but letting it manage the key set would let one leaked agent key mint replacements and
 * lock the owner out — so key management is the human/Bearer surface only, and the guard
 * fails closed on a missing scheme.
 *
 * `DELETE /keys/{id}` deliberately does NOT wear `requireJsonContentType`: DELETE is
 * already non-simple by method, so a content-type rule on a bodyless DELETE is theater.
 */
import { Router } from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type { ApiKeyService } from '../services/api-key-service.js';
import { requireAccessScheme } from '../middleware/auth-middleware.js';
import { requireJsonContentType } from '../middleware/json-content-type.js';
import { getLogger } from '../utils/logger.js';
import { optionalString, requireBody, requirePathParam } from '../utils/request-validation.js';
import type { Endpoints } from './endpoints.js';

const logger = getLogger('KeysEndpoints');

export class KeysEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(apiKeyService: ApiKeyService) {
    this.router = Router();

    this.router.post(
      '/keys',
      requireJsonContentType,
      requireAccessScheme,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const name = optionalString(requireBody(req), 'name');
          logger.info('POST /keys.');
          res.status(201).json(await apiKeyService.createApiKey({ name }));
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.get(
      '/keys',
      requireAccessScheme,
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          logger.info('GET /keys.');
          res.status(200).json(await apiKeyService.listApiKeys({}));
        } catch (err) {
          next(err);
        }
      },
    );

    this.router.delete(
      '/keys/:id',
      requireAccessScheme,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          logger.info('DELETE /keys/:id.');
          await apiKeyService.revokeApiKey({ keyId: requirePathParam(req, 'id') });
          res.status(204).end();
        } catch (err) {
          next(err);
        }
      },
    );
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
