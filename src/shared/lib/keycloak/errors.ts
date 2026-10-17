import { AppError, ConfigError } from '../errors'

// Errors of the Keycloak Admin API client. Their messages name the request and the status, and never carry
// a token, a client secret or a response body, because callers log them and show them to administrators.

/**
 * The Keycloak variables are missing or malformed, such as an issuer without /realms/<name>, or the realm lacks
 * the libredb client that holds the LibreDB roles.
 */
export class KeycloakConfigError extends ConfigError {
  constructor(message: string) {
    super(message)
    this.name = 'KeycloakConfigError'
  }
}

/** The token endpoint refused Platform's client credentials (400 or 401), or the Admin API refused a new token. */
export class KeycloakAuthError extends AppError {
  constructor(message: string) {
    super(message, 'KEYCLOAK_AUTH_ERROR', 502)
    this.name = 'KeycloakAuthError'
  }
}

/** The Admin API answered 403: the service account lacks a realm-management role. */
export class KeycloakPermissionError extends AppError {
  constructor(message: string) {
    super(message, 'KEYCLOAK_PERMISSION_ERROR', 502)
    this.name = 'KeycloakPermissionError'
  }
}

/** The Admin API answered 404 with a Keycloak JSON error body, so the resource does not exist. */
export class KeycloakNotFoundError extends AppError {
  constructor(message: string) {
    super(message, 'KEYCLOAK_NOT_FOUND', 404)
    this.name = 'KeycloakNotFoundError'
  }
}

/**
 * Keycloak did not answer as Keycloak: a network failure, a timeout, a 5xx, a 404 without a Keycloak JSON body
 * (such as an edge that hides the admin console), or any other unexpected answer.
 * Callers treat it as an unreachable directory, never as a missing user.
 */
export class KeycloakUnavailableError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'KEYCLOAK_UNAVAILABLE', 503)
    this.name = 'KeycloakUnavailableError'
    if (cause !== undefined) this.cause = cause
  }
}
