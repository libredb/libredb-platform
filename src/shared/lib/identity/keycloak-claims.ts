import { AppError } from '../errors'

/** The account behind a Keycloak sign-in, as its ID token describes it. */
export interface KeycloakIdentity {
  /** The Keycloak user id, the OIDC `sub`: the only key of the Platform user, never the email. */
  sub: string
  /** The Keycloak session id, which the session recheck looks for among the user's sessions. */
  sid: string | null
  /** A display label that two users may share. */
  email: string
  name: string | null
  /** The Keycloak username, from `preferred_username`. */
  username: string | null
  /** The roles of the flat role claim; the realm maps the client roles of `libredb` into it. */
  roles: string[]
}

/**
 * The ID token lacks a claim that Platform needs, or carries it in a shape Platform cannot read.
 * The message names the claim and never repeats a claim value.
 */
export class IdentityClaimError extends AppError {
  constructor(public readonly claim: string, problem: string) {
    super(`The ID token claim ${claim} ${problem}`, 'IDENTITY_CLAIM_ERROR', 401)
    this.name = 'IdentityClaimError'
  }
}

function requiredText(profile: Readonly<Record<string, unknown>>, claim: string): string {
  const value = profile[claim]
  if (typeof value !== 'string' || value === '') throw new IdentityClaimError(claim, 'is missing')
  return value
}

function optionalText(profile: Readonly<Record<string, unknown>>, claim: string): string | null {
  const value = profile[claim]
  return typeof value === 'string' && value !== '' ? value : null
}

// The claim is read by its whole name, so a dot in the name never means a nested path.
function readRoles(profile: Readonly<Record<string, unknown>>, roleClaim: string): string[] {
  const value = profile[roleClaim]
  // Keycloak leaves the claim out for an account that holds no client role of libredb.
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || !value.every(role => typeof role === 'string')) {
    throw new IdentityClaimError(roleClaim, 'must be a list of role names')
  }
  return [...value]
}

/**
 * Reads the ID-token profile of a Keycloak sign-in, with the roles from the flat claim that PLATFORM_ROLE_CLAIM names.
 * Throws IdentityClaimError for a missing `sub` or `email` and for a role claim that is not a list of role names.
 */
export function readKeycloakClaims(profile: Readonly<Record<string, unknown>> | undefined, roleClaim: string): KeycloakIdentity {
  const claims = profile ?? {}
  return {
    sub: requiredText(claims, 'sub'),
    sid: optionalText(claims, 'sid'),
    email: requiredText(claims, 'email'),
    name: optionalText(claims, 'name'),
    username: optionalText(claims, 'preferred_username'),
    roles: readRoles(claims, roleClaim),
  }
}
