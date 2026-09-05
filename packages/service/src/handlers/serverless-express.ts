/**
 * The one place `@codegenie/serverless-express` is adapted for TypeScript, shared by both
 * Lambda entry points (`service-handler.ts` and `mcp.ts`).
 *
 * The library does `module.exports = configure`, so the module itself IS the factory
 * function. Its bundled `index.d.ts` declares that with ESM `export default` syntax, which
 * TypeScript reads as `exports.default` for a package that is otherwise CommonJS — so the
 * declaration and the runtime disagree about the shape. The cast below picks the runtime
 * truth, which is what both esbuild and Vite's interop produce.
 */
import serverlessExpressDefault from '@codegenie/serverless-express';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import type { Express } from 'express';

export type ApiGatewayHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
  callback: () => void,
) => Promise<APIGatewayProxyStructuredResultV2>;

type ServerlessExpressFactory = (options: {
  readonly app: Express;
  readonly logSettings?: { readonly level: string };
}) => ApiGatewayHandler;

const configure = serverlessExpressDefault as unknown as ServerlessExpressFactory;

/**
 * Wrap an Express app as an API Gateway (HTTP API, payload v2) handler.
 *
 * `logSettings` is PINNED, not defaulted. serverless-express's `debug` level `util.inspect`s
 * the ENTIRE invoking event — which for the REST app includes the `cookies` array carrying
 * the live `__Host-fm_access` / `__Host-fm_refresh` session tokens, and for the MCP app the
 * `x-api-key` header. Turning that on would write a working credential into CloudWatch.
 * `error` is the library default; stating it here makes raising it a deliberate, reviewable
 * act rather than a one-word convenience.
 */
export function toApiGatewayHandler(app: Express): ApiGatewayHandler {
  return configure({ app, logSettings: { level: 'error' } });
}
