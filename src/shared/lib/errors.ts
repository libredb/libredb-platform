export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string) {
    super(`${entity} not found`, 'NOT_FOUND', 404)
  }
}

export class ForbiddenError extends AppError {
  constructor(permission?: string) {
    super(
      permission ? `Permission denied: ${permission}` : 'Permission denied',
      'FORBIDDEN',
      403,
    )
  }
}

export class ValidationError extends AppError {
  constructor(public readonly fieldErrors: Record<string, string[]>) {
    super('Validation failed', 'VALIDATION_ERROR', 422, { fieldErrors })
  }
}

export class LimitExceededError extends AppError {
  constructor(resource: string, max: number) {
    super(`Limit exceeded: ${resource} (max: ${max})`, 'LIMIT_EXCEEDED', 403)
  }
}

/**
 * The fixed text of each refusal of the license of a self-hosted install, which the admin sees as the error of the
 * refused write. No text names a license, a token or a count, so a refusal never carries license data.
 */
const LICENSE_LIMIT_MESSAGES = {
  LICENSE_EXPIRED:
    'The license has expired. Existing access keeps working, and adding users, connections or admins needs a renewed license.',
  LICENSE_INVALID:
    'The license could not be verified. Existing access keeps working, and adding users, connections or admins needs a valid license.',
  LICENSE_USER_SEATS:
    'Not enough user seats. Free a seat by revoking all grants of a user, or install a license with more user seats.',
  LICENSE_ADMIN_SEATS:
    'Not enough admin seats. Free a seat by removing the admin role from an account in Keycloak, or install a license with more admin seats.',
} as const

export type LicenseLimitCode = keyof typeof LICENSE_LIMIT_MESSAGES

/** Every code of a license refusal. */
export const LICENSE_LIMIT_CODES = Object.keys(LICENSE_LIMIT_MESSAGES) as readonly LicenseLimitCode[]

/**
 * The fixed text of a license refusal: the message of its LicenseLimitError, which a page also shows before the write,
 * such as next to a button that the license would refuse.
 */
export function licenseLimitMessage(code: LicenseLimitCode): string {
  return LICENSE_LIMIT_MESSAGES[code]
}

/**
 * A write that the license of a self-hosted install refuses: one under a license that could not be verified, one after
 * its expiry, or one beyond its user or admin seats.
 */
export class LicenseLimitError extends AppError {
  declare readonly code: LicenseLimitCode

  constructor(code: LicenseLimitCode) {
    super(licenseLimitMessage(code), code, 403)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401)
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', 500)
  }
}
