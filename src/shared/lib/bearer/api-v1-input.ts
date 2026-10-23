import type { ZodType } from 'zod'
import { ValidationError } from '../errors'

/**
 * The input of a /api/v1 route checked against its schema, as safeAction checks the input of a Server Action: a
 * failure throws ValidationError with the messages of each field, which the route answers 400 VALIDATION_FAILED.
 */
export function parseApiInput<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const fieldErrors: Record<string, string[]> = {}
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.')
    fieldErrors[path] = fieldErrors[path] ?? []
    fieldErrors[path].push(issue.message)
  }
  throw new ValidationError(fieldErrors)
}

/** The JSON body of a request, which must be an object; anything else throws ValidationError on `body`. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ValidationError({ body: ['must be a JSON object'] })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError({ body: ['must be a JSON object'] })
  }
  return body as Record<string, unknown>
}
