/**
 * Forwarding-rule management: list, create, update (replace), delete.
 *
 * Every route is `requireAccessScheme`-guarded: one rule can copy every received message to an
 * outside address, so only the signed-in human may edit them — never an `x-api-key` agent, and
 * the guard fails closed on a missing scheme.
 *
 * The body is parsed for shape only (strings, string arrays, booleans; absent lists are empty,
 * `enabled` defaults on, `ignoreDmarcVerification` off). What the values mean is the service's
 * check, shared with the web app. `DELETE` wears no `requireJsonContentType`: it is already
 * non-simple by method.
 */
import type { ForwardingRuleFields } from '@freemail/shared';
import { Router } from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type { ForwardingRuleService } from '../services/forwarding-rule-service.js';
import { requireAccessScheme } from '../middleware/auth-middleware.js';
import { requireJsonContentType } from '../middleware/json-content-type.js';
import { getLogger } from '../utils/logger.js';
import { optionalBoolean, optionalString, optionalStringArray, requireBody, requirePathParam } from '../utils/request-validation.js';
import type { Endpoints } from './endpoints.js';

const logger = getLogger('ForwardingRuleEndpoints');

export class ForwardingRuleEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(service: ForwardingRuleService) {
    this.router = Router();

    this.router.get('/forwarding-rules', requireAccessScheme, async (_req: Request, res: Response, next: NextFunction) => {
      try {
        logger.info('GET /forwarding-rules.');
        res.status(200).json(await service.listForwardingRules({}));
      } catch (err) {
        next(err);
      }
    });

    this.router.post('/forwarding-rules', requireJsonContentType, requireAccessScheme, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const fields = ruleFields(requireBody(req));
        logger.info('POST /forwarding-rules.');
        res.status(201).json(await service.createForwardingRule(fields));
      } catch (err) {
        next(err);
      }
    });

    this.router.put('/forwarding-rules/:id', requireJsonContentType, requireAccessScheme, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = requirePathParam(req, 'id');
        const fields = ruleFields(requireBody(req));
        logger.info('PUT /forwarding-rules/:id.');
        res.status(200).json(await service.updateForwardingRule({ ...fields, id }));
      } catch (err) {
        next(err);
      }
    });

    this.router.delete('/forwarding-rules/:id', requireAccessScheme, async (req: Request, res: Response, next: NextFunction) => {
      try {
        logger.info('DELETE /forwarding-rules/:id.');
        await service.deleteForwardingRule({ id: requirePathParam(req, 'id') });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}

/** The editable fields from a body, by shape; the service checks what they mean. */
function ruleFields(body: Record<string, unknown>): ForwardingRuleFields {
  return {
    name: optionalString(body, 'name') ?? '',
    enabled: optionalBoolean(body, 'enabled') ?? true,
    senderDomains: optionalStringArray(body, 'senderDomains') ?? [],
    senderAddresses: optionalStringArray(body, 'senderAddresses') ?? [],
    recipientDomains: optionalStringArray(body, 'recipientDomains') ?? [],
    recipientAddresses: optionalStringArray(body, 'recipientAddresses') ?? [],
    forwardTo: optionalStringArray(body, 'forwardTo') ?? [],
    ignoreDmarcVerification: optionalBoolean(body, 'ignoreDmarcVerification') ?? false,
  };
}
