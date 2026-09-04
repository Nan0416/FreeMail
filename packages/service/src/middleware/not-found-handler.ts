/**
 * Terminal 404 for any request that matched no route. Registered after every endpoint and
 * before the error handler, so an unrouted request gets the same JSON error shape as
 * everything else rather than Express's default HTML page.
 *
 * API Gateway only forwards requests that matched a declared route, so reaching this in
 * production means the CDK route table and the Express routers have drifted apart.
 */
import type { AuthErrorBody } from '@freemail/shared';
import type { Request, RequestHandler, Response } from 'express';

export const notFoundHandler: RequestHandler = (_req: Request, res: Response): void => {
  res.status(404).json({
    error: 'invalid_request',
    message: 'Not found.',
  } satisfies AuthErrorBody);
};
