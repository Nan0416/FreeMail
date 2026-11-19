/**
 * Routes for other backend services, under `/api`. API Gateway reaches them only through the
 * IAM-authorized `ANY /api/{proxy+}` route; every `/api` path also checks for the IAM caller
 * here, so a session or API-key request can never reach them.
 */
import { Router } from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { requireIamCaller } from '../middleware/auth-middleware.js';
import type { EmailReadService } from '../services/email-read-service.js';
import { getLogger } from '../utils/logger.js';
import { requirePathParam } from '../utils/request-validation.js';
import type { Endpoints } from './endpoints.js';

const logger = getLogger('ServiceApiEndpoints');

export class ServiceApiEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(readService: EmailReadService) {
    this.router = Router();

    // Every /api path, unknown ones included.
    this.router.use('/api', requireIamCaller);

    // Placeholder for checking IAM authorization end to end: echoes the verified caller.
    this.router.get('/api/test', (req: Request, res: Response) => {
      logger.info('GET /api/test.');
      res.status(200).json({ ok: true, caller: req.iamCaller });
    });

    // One message, by the `id` from the email-received notification, with a presigned
    // download URL on every attachment.
    this.router.get('/api/emails/:id', async (req: Request, res: Response, next: NextFunction) => {
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
