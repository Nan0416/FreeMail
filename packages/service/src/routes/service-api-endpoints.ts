/**
 * Routes for other backend services, under `/api`. They sit behind the same Lambda authorizer
 * as `/mcp` and take the same credential: an `x-api-key` (or the web session).
 */
import { Router } from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { requireAuthenticated } from '../middleware/auth-middleware.js';
import type { EmailReadService } from '../services/email-read-service.js';
import { getLogger } from '../utils/logger.js';
import { requirePathParam } from '../utils/request-validation.js';
import type { Endpoints } from './endpoints.js';

const logger = getLogger('ServiceApiEndpoints');

export class ServiceApiEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(readService: EmailReadService) {
    this.router = Router();

    // One message, by the `id` from the email-received notification, with a presigned
    // download URL on every attachment.
    this.router.get('/api/emails/:id', requireAuthenticated, async (req: Request, res: Response, next: NextFunction) => {
      try {
        logger.info('GET /api/emails/:id.');
        res.status(200).json(await readService.getEmailWithDownloadUrls({ handle: requirePathParam(req, 'id') }));
      } catch (err) {
        next(err);
      }
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
