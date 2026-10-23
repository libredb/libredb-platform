import { AppError } from '../errors'

// The refusals of the bearer API under /api/v1 (docs/api/v1.md). Their messages never carry the token or a claim value.

/**
 * The request carries no bearer token, or one that fails a check: its signature, issuer, audience, client, lifetime or
 * a claim Platform needs. api-v1-response.ts answers it with the invalid_token challenge.
 */
export class BearerInvalidError extends AppError {
  constructor(message: string) {
    super(message, 'BEARER_INVALID', 401)
    this.name = 'BearerInvalidError'
  }
}

/** The token is valid, and its role claim lacks PLATFORM_ADMIN_ROLE. */
export class AdminRoleRequiredError extends AppError {
  constructor() {
    super('The account lacks the Platform admin role', 'ADMIN_ROLE_REQUIRED', 403)
    this.name = 'AdminRoleRequiredError'
  }
}

/**
 * The keys of the identity provider could not be read, so no token can be checked. Never a 401, so an app does not
 * sign its user out over an outage.
 */
export class IdentityProviderUnavailableError extends AppError {
  constructor(cause?: unknown) {
    super('The identity provider is unavailable', 'IDENTITY_PROVIDER_UNAVAILABLE', 503)
    this.name = 'IdentityProviderUnavailableError'
    if (cause !== undefined) this.cause = cause
  }
}

/** Cloud mode, or a self-hosted install without PLATFORM_API_AUDIENCE. */
export class ApiDisabledError extends AppError {
  constructor() {
    super('The bearer API is not enabled on this install', 'API_DISABLED', 404)
    this.name = 'ApiDisabledError'
  }
}
