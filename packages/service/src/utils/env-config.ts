/**
 * The one way a Lambda reads its environment.
 *
 * Every FreeMail Lambda has a DIFFERENT environment contract — CDK gives the REST handler
 * the auth and API-key tables, the MCP handler neither, the inbound parser only the emails
 * table and the mail bucket. So each handler declares its own config (conduit's
 * `handlers/<name>-config.ts` convention) and they all validate through here.
 *
 * Validating the whole set up front, rather than letting each collaborator discover its own
 * missing variable on the first request that needs it, means a misconfigured deployment
 * fails once, loudly, naming EVERY variable it is missing — instead of failing differently
 * per route and needing three redeploys to find three problems.
 *
 * FreeMail uses zod here where conduit hand-rolls a `getenv` per config file; the project
 * already depends on zod, and one schema per Lambda is what makes the all-at-once error
 * possible.
 */
import { z } from 'zod';

/** A required, non-empty environment variable. */
export const envString = () => z.string().min(1);

/**
 * Read and validate one Lambda's environment against its schema.
 *
 * An empty string is treated as ABSENT: an unset CDK value can surface either way, and `""`
 * is never a usable table name, bucket, or domain.
 */
export function parseEnv<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  component: string,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<z.ZodObject<Shape>> {
  const present: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      present[key] = value;
    }
  }

  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].sort();
    throw new Error(
      `FreeMail ${component} is misconfigured: missing or empty environment variable(s): ${names.join(', ')}.`,
    );
  }
  return parsed.data;
}
