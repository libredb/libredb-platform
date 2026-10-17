import type { AuthProvider, TenantSummary } from '@/shared/types'

// The fields that the callbacks of src/shared/lib/identity/auth-callbacks.ts write on the Auth.js token and session.
// The token is encrypted with AUTH_SECRET and stays on the server; the session payload is also what
// useSession() sends to the browser, so the Keycloak fields of the token never reach it.
// They augment the next-auth modules rather than @auth/core, because next-auth resolves its own copy of @auth/core.

declare module 'next-auth' {
  interface Session {
    authProvider: AuthProvider
    currentTenantId: string | null
    membershipId: string | null
    roles: string[]
    permissions: string[]
    accessibleTenants: TenantSummary[]
    /** True while a Keycloak session lives on its grace because the session recheck cannot read the directory. */
    directoryDegraded: boolean
  }
}

// Optional, because Auth.js hands the jwt callback its default token at a sign-in and older tokens afterwards; the
// callbacks check the fields before they rely on them.
declare module 'next-auth/jwt' {
  interface JWT {
    /** The Platform user id, users.id; sub holds the same value. */
    id?: string
    authProvider?: AuthProvider
    /** When the session's access was last read, in seconds since the epoch. */
    checkedAt?: number
    currentTenantId?: string | null
    membershipId?: string | null
    roles?: string[]
    permissions?: string[]
    accessibleTenants?: TenantSummary[]
    /** Keycloak sessions only: the Keycloak user id, the `sub` of the ID token. */
    keycloakId?: string
    /** Keycloak sessions only: the Keycloak session id of the ID token. */
    sid?: string | null
    /** Keycloak sessions only: the raw ID token, the id_token_hint of the Keycloak logout. */
    idToken?: string
    /** Keycloak sessions only: the refresh token of the Keycloak session, which each due recheck spends to keep it alive. */
    refreshToken?: string
    /** Keycloak sessions only: the last recheck attempt, whatever its verdict, in seconds since the epoch. */
    recheckAttemptedAt?: number
    /** Keycloak sessions only: true while the session lives on its grace, because the recheck could not read the directory. */
    directoryDegraded?: boolean
  }
}
