import { AppError, ForbiddenError } from './errors'
import { KeycloakUnavailableError } from './keycloak/errors'
import type { CurrentUser } from '../types'

/**
 * Refuses an action that reads the Keycloak directory while the session lives on its grace, because the session recheck
 * cannot reach the Keycloak Admin API. The grant actions and the Studio users listing call it first.
 */
export function requireDirectory(user: Pick<CurrentUser, 'directoryDegraded'>): void {
  if (user.directoryDegraded) {
    throw new ForbiddenError('the Keycloak directory is unreachable')
  }
}

/**
 * A read of the Keycloak directory that Keycloak did not answer, which the bearer API answers 503
 * DIRECTORY_UNAVAILABLE. It keeps the message of the Admin API client, which a Server Action shows as before.
 */
export class DirectoryUnavailableError extends AppError {
  constructor(cause: KeycloakUnavailableError) {
    super(cause.message, 'DIRECTORY_UNAVAILABLE', 503)
    this.name = 'DirectoryUnavailableError'
    this.cause = cause
  }
}

/** Runs a read of the Keycloak directory, and throws DirectoryUnavailableError when Keycloak does not answer it. */
export async function readDirectory<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof KeycloakUnavailableError) throw new DirectoryUnavailableError(error)
    throw error
  }
}
