/**
 * RFC 8785 canonical JSON (JCS) for what an `lsb1` envelope binds: a connection definition, and the
 * additional authenticated data that carries the digest of its canonical form.
 *
 * Platform's sealer and Studio's opener each hash the canonical definition, so both must turn the same value into the
 * same bytes whatever order its keys arrive in: no whitespace, object keys sorted by their UTF-16 code units, and
 * strings and numbers written as ECMAScript's `JSON.stringify` writes them.
 *
 * Only the values a definition may hold have a canonical form here: strings, booleans, null, safe integers (magnitude
 * below 2^53, as `Number.isSafeInteger` decides, which is what Studio's opener admits), and plain objects and arrays of
 * these. So a non-finite number, a fraction and an unsafe integer are refused, as are values JSON cannot carry and,
 * as RFC 8785 requires, text that is not well-formed Unicode. A refusal names the JSON path of the value, never the
 * value.
 */

/** Why a value has no canonical form, or is not one a definition may hold. */
export class CanonicalJsonError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${reason} (at ${path})`)
    this.name = 'CanonicalJsonError'
  }
}

/** A JSON object as `JSON.parse` builds it: its prototype is `Object.prototype`, or null. */
export function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Orders strings by their UTF-16 code units, as RFC 8785 section 3.2.3 sorts object keys; not by locale. */
function byCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function serialize(value: unknown, path: string): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    // RFC 8785 section 3.2.2.2: a lone surrogate has no canonical form.
    if (!value.isWellFormed()) throw new CanonicalJsonError(path, 'A string must be well-formed Unicode')
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError(path, 'A number that is not finite has no JSON form')
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalJsonError(path, 'A definition number must be an integer whose magnitude is below 2^53')
    }
    // ECMAScript writes a safe integer in plain decimal digits, and -0 as 0.
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    // Array.from visits a hole as undefined, which is refused, where JSON.stringify would write null for it.
    return `[${Array.from(value, (item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`
  }
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .sort(byCodeUnits)
      .map((key) => {
        if (!key.isWellFormed()) throw new CanonicalJsonError(path, 'An object key must be well-formed Unicode')
        return `${JSON.stringify(key)}:${serialize(value[key], `${path}.${key}`)}`
      })
    return `{${members.join(',')}}`
  }
  throw new CanonicalJsonError(
    path,
    'Only null, booleans, strings, safe integers, arrays and plain objects have a canonical form',
  )
}

/** The RFC 8785 canonical JSON text of `value`, which must be made of the values a definition may hold. */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$')
}

/** The canonical JSON text of a connection definition, which must be a JSON object. */
export function canonicalDefinition(definition: unknown): string {
  if (!isPlainObject(definition)) throw new CanonicalJsonError('$', 'A definition must be a JSON object')
  return serialize(definition, '$')
}
