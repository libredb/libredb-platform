import { createRemoteJWKSet, errors, type JWTVerifyGetKey } from 'jose'
import { IdentityProviderUnavailableError } from './errors'

/** Milliseconds a read of the discovery document may take, as jose allows the JWKS read by default. */
const DISCOVERY_TIMEOUT_MS = 5_000

async function discoverJwksUri(issuer: string): Promise<URL> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    redirect: 'manual',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (response.status !== 200) throw new Error(`The discovery document answered ${response.status}`)
  const document = (await response.json()) as { jwks_uri?: unknown }
  if (typeof document.jwks_uri !== 'string') throw new Error('The discovery document has no jwks_uri')
  return new URL(document.jwks_uri)
}

/**
 * The keys of an OIDC issuer for jwtVerify: the JWKS that the issuer's discovery document names, which
 * createRemoteJWKSet caches and reloads when a token names a key it does not hold.
 * A discovery document or a JWKS that cannot be read raises IdentityProviderUnavailableError, and the next call asks
 * again; a token whose key the JWKS lacks keeps jose's own error, which verify-access-token.ts answers with a 401.
 */
export function createIssuerKeys(issuer: string): JWTVerifyGetKey {
  let remote: Promise<JWTVerifyGetKey> | undefined

  return async (protectedHeader, token) => {
    remote ??= discoverJwksUri(issuer).then(uri => createRemoteJWKSet(uri))
    let keys: JWTVerifyGetKey
    try {
      keys = await remote
    } catch (error) {
      remote = undefined
      throw new IdentityProviderUnavailableError(error)
    }
    try {
      return await keys(protectedHeader, token)
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) throw error
      throw new IdentityProviderUnavailableError(error)
    }
  }
}

const issuerKeys = new Map<string, JWTVerifyGetKey>()

/** The keys of `issuer`, shared by every request of this process. */
export function getIssuerKeys(issuer: string): JWTVerifyGetKey {
  let keys = issuerKeys.get(issuer)
  if (keys === undefined) {
    keys = createIssuerKeys(issuer)
    issuerKeys.set(issuer, keys)
  }
  return keys
}
