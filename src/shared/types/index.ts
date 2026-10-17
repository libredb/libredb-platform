/** How a session signed in: with a cloud password (Credentials) or through Keycloak single sign-on in self-hosted mode. */
export type AuthProvider = 'credentials' | 'keycloak'

export interface TenantSummary {
  id: string
  name: string
  slug: string
}

export interface CurrentUser {
  id: string
  email: string
  name: string | null
  currentTenantId: string | null
  membershipId: string | null
  roles: string[]
  permissions: string[]
  accessibleTenants: TenantSummary[]
  /** The provider of the session, which the session payload carries as authProvider. */
  authProvider: AuthProvider
  /**
   * True while a Keycloak session lives on its grace because the session recheck cannot read the Keycloak directory;
   * always false for a Credentials session.
   */
  directoryDegraded: boolean
}

export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: string; fieldErrors?: Record<string, string[]> }
