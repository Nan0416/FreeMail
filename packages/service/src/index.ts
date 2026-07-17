/**
 * FreeMail backend — Lambda handlers for the REST API and the MCP server.
 *
 * Concrete handlers (auth, send, MCP tools) arrive with issues #4+. This entry
 * point wires the shared health helper to prove the cross-package build graph.
 */
import { healthOk, type HealthReport } from '@freemail/shared';

export function serviceHealth(): HealthReport {
  return healthOk('@freemail/service');
}
