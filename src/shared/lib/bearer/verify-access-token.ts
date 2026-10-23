import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { IdentityClaimError, readKeycloakClaims, type KeycloakIdentity } from '../identity/keycloak-claims'
import { AdminRoleRequiredError, BearerInvalidError } from './errors'

/** What an access token of the bearer API must satisfy (runtime-config.ts). */
export interface AccessTokenSettings {
  /** AUTH_KEYCLOAK_ISSUER: the only issuer whose tokens pass. */
  issuer: string
  /** PLATFORM_API_AUDIENCE: an audience that `aud` must hold. */
  audience: string
  /** PLATFORM_API_CLIENT_IDS: the clients whose tokens pass, compared with `azp`. */
  clientIds: readonly string[]
  /** PLATFORM_ROLE_CLAIM: the flat claim that carries the roles. */
  roleClaim: string
  /** PLATFORM_ADMIN_ROLE: the role a token must hold, as for the web sign-in. */
  adminRole: string
}

// Asymmetric algorithms only: a key the issuer publishes can never verify an HS* token, and `none` never passes.
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA', 'Ed25519']

// The header types of an access token: plain JWT, and RFC 9068's at+jwt, bare or as its media type.
const ACCESS_TOKEN_HEADER_TYPES = ['jwt', 'at+jwt', 'application/at+jwt']

// The value of the typ claim that marks an access token where the issuer sets one, as Keycloak does; its ID and
// refresh tokens carry ID and Refresh, so neither passes even when it holds the audience.
const ACCESS_TOKEN_TYP_CLAIM = 'Bearer'

/** Seconds of clock skew allowed on `exp` and `nbf`. */
const CLOCK_TOLERANCE_SECONDS = 30

function bearerInvalid(error: errors.JOSEError): BearerInvalidError {
  if (error instanceof errors.JWTExpired) return new BearerInvalidError('The bearer token has expired')
  if (error instanceof errors.JWTClaimValidationFailed) {
    return new BearerInvalidError(`The bearer token claim ${error.claim} is not valid`)
  }
  return new BearerInvalidError('The bearer token is not valid')
}

/**
 * Checks an OIDC access token with standard JWT rules: an asymmetric signature by a key of `keys`, `iss`, `aud`, `azp`,
 * `exp` and `nbf` with 30 seconds of skew, and `sub`. A header `typ` must name a JWT or an RFC 9068 access token, and a
 * `typ` claim, which only some issuers set, must be Bearer, so another kind of token that holds the audience is refused; then reads the identity with the claims the web sign-in reads and
 * requires PLATFORM_ADMIN_ROLE in the role claim.
 * Throws BearerInvalidError for a token that fails a check, AdminRoleRequiredError for a valid token without the
 * admin role, and passes on IdentityProviderUnavailableError from `keys` (issuer-keys.ts).
 */
export async function verifyAccessToken(
  token: string,
  settings: AccessTokenSettings,
  keys: JWTVerifyGetKey,
  now: Date = new Date(),
): Promise<KeycloakIdentity> {
  let claims: Record<string, unknown>
  try {
    const verified = await jwtVerify(token, keys, {
      algorithms: ALGORITHMS,
      issuer: settings.issuer,
      audience: settings.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['exp', 'sub'],
      currentDate: now,
    })
    const headerType = verified.protectedHeader.typ
    if (headerType !== undefined && !ACCESS_TOKEN_HEADER_TYPES.includes(headerType.toLowerCase())) {
      throw new BearerInvalidError('The bearer token is not an access token')
    }
    claims = verified.payload
  } catch (error) {
    if (error instanceof BearerInvalidError) throw error
    if (error instanceof errors.JOSEError) throw bearerInvalid(error)
    throw error
  }

  if (claims.typ !== undefined && claims.typ !== ACCESS_TOKEN_TYP_CLAIM) {
    throw new BearerInvalidError('The bearer token is not an access token')
  }

  if (typeof claims.azp !== 'string' || !settings.clientIds.includes(claims.azp)) {
    throw new BearerInvalidError('The bearer token was issued to a client this API does not accept')
  }

  let identity: KeycloakIdentity
  try {
    identity = readKeycloakClaims(claims, settings.roleClaim)
  } catch (error) {
    if (error instanceof IdentityClaimError) throw new BearerInvalidError(`The bearer token claim ${error.claim} is not valid`)
    throw error
  }
  if (!identity.roles.includes(settings.adminRole)) throw new AdminRoleRequiredError()
  return identity
}
