/**
 * The public outbound large-attachment download (#14): `GET /d/{token}`.
 *
 * PUBLIC — no authorizer, because the token IS the capability. The whole path stays in
 * HTML space: a valid token yields a `302` to a freshly minted, short-lived presigned GET
 * (the S3 bucket and key are never disclosed), and EVERY failure — unknown, malformed,
 * expired, revoked, exhausted — yields the same 404 page. One uniform failure means no
 * oracle, and the failing token is never reflected into the page.
 *
 * Both responses are `no-store`, so no cache can serve a stale redirect or a
 * since-revoked link.
 */
import { Router } from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type { DownloadService } from '../services/download-service.js';
import { getLogger } from '../utils/logger.js';
import { noStore } from '../utils/web-session.js';
import type { Endpoints } from './endpoints.js';

const logger = getLogger('DownloadEndpoints');

/** A public, human-facing page. Uniform for every cause; no reflected input. */
const NOT_FOUND_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Link unavailable</title></head>' +
  '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222">' +
  '<h1>This link is no longer available</h1>' +
  '<p>The download link has expired or is no longer valid.</p></body></html>';

export class DownloadEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(downloadService: DownloadService) {
    this.router = Router();

    this.router.get('/d/:token', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const token = req.params.token;
        // Not `requirePathParam`: a 400 with a JSON body would break the HTML contract and
        // tell a prober that an absent token differs from a rejected one.
        if (typeof token !== 'string' || token.length === 0) {
          notFound(res);
          return;
        }
        const result = await downloadService.resolve({ token });
        if (!result) {
          logger.info('GET /d/:token — no usable token.');
          notFound(res);
          return;
        }
        // NOT `res.redirect()`: Express writes an HTML body echoing the Location URL,
        // which would put the presigned S3 URL in the response body. Bodyless by design.
        noStore(res);
        res.status(302).set('Location', result.url).end();
      } catch (err) {
        next(err);
      }
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}

function notFound(res: Response): void {
  noStore(res);
  res.status(404).type('html').send(NOT_FOUND_HTML);
}
