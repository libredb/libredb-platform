import type { RuntimeConfig } from '../runtime-config'
import { KeycloakConfigError } from './errors'

/** The variables of the validated runtime configuration (`getRuntimeConfig()`) that the Admin API client reads. */
export type KeycloakEnv = Partial<
  Pick<RuntimeConfig, 'AUTH_KEYCLOAK_ISSUER' | 'AUTH_KEYCLOAK_ID' | 'AUTH_KEYCLOAK_SECRET' | 'KEYCLOAK_ADMIN_URL'>
>

export interface KeycloakAdminConfig {
  /** The realm segment of the issuer path, as it appears in URLs. */
  realm: string
  /** `<base>/admin/realms/<realm>`, which every Admin API path extends. */
  adminBaseUrl: string
  /** `<base>/realms/<realm>/protocol/openid-connect/token`, where the service account gets its token. */
  tokenEndpoint: string
  clientId: string
  clientSecret: string
}

// The rules of both URL variables, shared with the runtime configuration so both report the same message.
export const KEYCLOAK_ISSUER_RULE =
  'must be an absolute http(s) URL ending in /realms/<realm>, without credentials, query or fragment'
export const KEYCLOAK_ADMIN_URL_RULE = 'must be an absolute http(s) URL without credentials, query or fragment'

// The origin and path of an absolute http(s) URL without credentials, query or fragment; null for any other value.
function plainHttpUrl(value: string): { origin: string; pathname: string } | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // `href` also catches an empty query or fragment, such as a trailing `?`, which `search` and `hash` hide.
  if (url.username !== '' || url.password !== '' || url.href !== `${url.origin}${url.pathname}`) return null
  return { origin: url.origin, pathname: url.pathname }
}

/** Splits a Keycloak issuer `<base>/realms/<realm>` into its base URL and realm; null for any other value. */
export function parseKeycloakIssuer(issuer: string): { baseUrl: string; realm: string } | null {
  const url = plainHttpUrl(issuer)
  const match = url && /^(.*)\/realms\/([^/]+)$/.exec(url.pathname)
  if (!url || !match) return null
  return { baseUrl: `${url.origin}${match[1]}`, realm: match[2] }
}

/** The base URL of a Keycloak server, such as KEYCLOAK_ADMIN_URL, without its trailing slashes; null when invalid. */
export function parseKeycloakBaseUrl(value: string): string | null {
  const url = plainHttpUrl(value)
  return url && `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * Derives the Admin API endpoints from the validated runtime configuration.
 * KEYCLOAK_ADMIN_URL, when set, is the base of both the Admin API and the token endpoint, so the token is requested
 * at the URL that the Admin API is called at; otherwise the issuer's `/realms/<realm>` becomes `/admin/realms/<realm>`.
 * Throws one KeycloakConfigError that names every missing or invalid variable, never its value.
 */
export function keycloakAdminConfig(env: KeycloakEnv): KeycloakAdminConfig {
  const problems: string[] = []
  for (const name of ['AUTH_KEYCLOAK_ISSUER', 'AUTH_KEYCLOAK_ID', 'AUTH_KEYCLOAK_SECRET'] as const) {
    if (!env[name]) problems.push(`${name} is required`)
  }
  const issuer = env.AUTH_KEYCLOAK_ISSUER ? parseKeycloakIssuer(env.AUTH_KEYCLOAK_ISSUER) : null
  if (env.AUTH_KEYCLOAK_ISSUER && !issuer) problems.push(`AUTH_KEYCLOAK_ISSUER ${KEYCLOAK_ISSUER_RULE}`)
  const adminUrl = env.KEYCLOAK_ADMIN_URL ? parseKeycloakBaseUrl(env.KEYCLOAK_ADMIN_URL) : null
  if (env.KEYCLOAK_ADMIN_URL && !adminUrl) problems.push(`KEYCLOAK_ADMIN_URL ${KEYCLOAK_ADMIN_URL_RULE}`)

  // Without problems the last three checks always pass; they narrow the types.
  if (problems.length > 0 || !issuer || !env.AUTH_KEYCLOAK_ID || !env.AUTH_KEYCLOAK_SECRET) {
    throw new KeycloakConfigError(`Invalid Keycloak Admin API configuration: ${problems.join('; ')}`)
  }

  const baseUrl = adminUrl ?? issuer.baseUrl
  return {
    realm: issuer.realm,
    adminBaseUrl: `${baseUrl}/admin/realms/${issuer.realm}`,
    tokenEndpoint: `${baseUrl}/realms/${issuer.realm}/protocol/openid-connect/token`,
    clientId: env.AUTH_KEYCLOAK_ID,
    clientSecret: env.AUTH_KEYCLOAK_SECRET,
  }
}
