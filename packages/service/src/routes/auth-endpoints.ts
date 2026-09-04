/**
 * The session surface: password login (which enrolls on first use, #42), refresh
 * rotation, logout, and the authenticated `GET /me` echo.
 *
 * Tokens ride in httpOnly cookies (#31), never in a response body, so every route here is
 * `no-store` and the refresh credential is read ONLY from the `__Host-fm_refresh` cookie —
 * never a body or query parameter. The mutating routes wear `requireJsonContentType`
 * (#47 Layer 3), including the bodyless refresh/logout.
 */
import type { SessionResponse } from '@freemail/shared';
import { Router } from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { AuthError, authErrors } from '../utils/errors.js';
import { OWNER_SUBJECT } from '../services/auth-service.js';
import type { AuthService } from '../services/auth-service.js';
import { getAuthContext } from '../middleware/auth-middleware.js';
import { requireJsonContentType } from '../middleware/json-content-type.js';
import { getLogger } from '../utils/logger.js';
import { requireBody, requireString } from '../utils/request-validation.js';
import {
  clearSession,
  noStore,
  readRefreshCookie,
  setSessionCookies,
} from '../utils/web-session.js';
import type { Endpoints } from './endpoints.js';

const logger = getLogger('AuthEndpoints');

export class AuthEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(authService: AuthService) {
    this.router = Router();

    this.router.post(
      '/auth/login',
      requireJsonContentType,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const password = requireString(requireBody(req), 'password');
          logger.info('POST /auth/login.');
          const pair = await authService.login({ password });
          noStore(res);
          setSessionCookies(res, pair.accessToken, pair.refreshToken);
          // Tokens ride in httpOnly cookies; the body only echoes the session subject.
          res.status(200).json({ subject: OWNER_SUBJECT } satisfies SessionResponse);
        } catch (err) {
          next(err);
        }
      },
    );

    // Every failure path — absent, duplicate/injected, malformed, expired, or replayed —
    // clears BOTH cookies and returns the auth error, so a failed refresh can never leave
    // a partial session or emit a refreshed credential.
    this.router.post(
      '/auth/refresh',
      requireJsonContentType,
      async (_req: Request, res: Response, next: NextFunction) => {
        const refreshToken = readRefreshCookie();
        if (refreshToken === null) {
          // Rejected without calling the service at all: an absent cookie must not cost an
          // auth-table read, and must be indistinguishable from a rejected one.
          logger.info('POST /auth/refresh — no usable refresh cookie.');
          refreshFailure(res, authErrors.invalidToken());
          return;
        }
        try {
          logger.info('POST /auth/refresh.');
          const pair = await authService.refresh({ refreshToken });
          noStore(res);
          setSessionCookies(res, pair.accessToken, pair.refreshToken);
          res.status(204).end();
        } catch (err) {
          if (err instanceof AuthError) {
            refreshFailure(res, err);
            return;
          }
          // Anything else is a bug, not a rejected credential: let the error handler turn
          // it into a clean 500 rather than reporting it as an expired session.
          next(err);
        }
      },
    );

    // Server-side revoke of the presented refresh token, then always clear both cookies.
    // The tokens are httpOnly, so ONLY this response's `Set-Cookie` can clear the browser
    // copy — both clears are therefore emitted on EVERY path, including when revocation
    // throws. A revocation failure returns a non-2xx (the client must not report a clean
    // sign-out when the server session may still be live) but still attaches the clears
    // to best-effort remove the browser copy.
    this.router.post(
      '/auth/logout',
      requireJsonContentType,
      async (_req: Request, res: Response) => {
        const refreshToken = readRefreshCookie();
        try {
          if (refreshToken !== null) {
            logger.info('POST /auth/logout.');
            await authService.logout({ refreshToken });
          }
        } catch {
          logger.warn('POST /auth/logout — revocation failed; clearing cookies anyway.');
          noStore(res);
          clearSession(res);
          res.status(500).json({
            error: 'invalid_request',
            message: 'Sign-out could not complete. Please retry.',
          });
          return;
        }
        noStore(res);
        clearSession(res);
        res.status(204).end();
      },
    );

    this.router.get('/me', (req: Request, res: Response, next: NextFunction) => {
      try {
        res.status(200).json({ subject: getAuthContext(req).subject } satisfies SessionResponse);
      } catch (err) {
        next(err);
      }
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}

/** An auth error response that also clears both session cookies (no-store, never cached). */
function refreshFailure(res: Response, error: AuthError): void {
  noStore(res);
  clearSession(res);
  res.status(error.status).json({ error: error.code, message: error.message });
}
