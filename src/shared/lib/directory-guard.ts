import { ForbiddenError } from './errors'
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
