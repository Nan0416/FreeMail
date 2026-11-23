import type { z } from 'zod';

export type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: string };

/** Validates `value`, describing every problem on one line (`response.to: Invalid input: ...; response.id: ...`). */
export function validateValue<T>(schema: z.ZodType<T>, value: unknown, dataVar: string): ValidationResult<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const errors = result.error.issues.map((issue) => `${[dataVar, ...issue.path.map(String)].join('.')}: ${issue.message}`).join('; ');
  return { ok: false, errors };
}
