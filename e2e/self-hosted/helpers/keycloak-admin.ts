// Drives the fixture realm of docker-compose.test.yml through the Admin REST API of Keycloak, signed in as the master
// administrator that the compose file bootstraps (KC_BOOTSTRAP_ADMIN_USERNAME and KC_BOOTSTRAP_ADMIN_PASSWORD).
// The Keycloak base URL and the realm come from AUTH_KEYCLOAK_ISSUER, the issuer the Platform server under test uses.

/** The master administrator of the test compose; KEYCLOAK_TEST_ADMIN_USERNAME and _PASSWORD override it. */
const ADMIN_USERNAME = process.env.KEYCLOAK_TEST_ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.KEYCLOAK_TEST_ADMIN_PASSWORD ?? 'admin'

/** The role-holder client whose client roles admin and user are the LibreDB roles. */
const ROLE_CLIENT_ID = 'libredb'

/** Platform's client, whose redirect URIs Platform's sign-in and sign-out send the browser back through. */
const PLATFORM_CLIENT_ID = 'libredb-platform'

/** The attribute that holds a client's post-logout redirect URIs, separated by `##`. */
const POST_LOGOUT_REDIRECT_URIS = 'post.logout.redirect.uris'

/** A session of a user in the realm, as GET /admin/realms/{realm}/users/{id}/sessions lists it. */
export interface KeycloakUserSession {
  id: string
  userId: string
  username: string
  /** The client ids of the session, keyed by the client's internal id. */
  clients: Record<string, string>
}

function realmOfIssuer(): { baseUrl: string; realm: string } {
  const issuer = process.env.AUTH_KEYCLOAK_ISSUER
  if (!issuer) {
    throw new Error('AUTH_KEYCLOAK_ISSUER must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env')
  }
  const match = /^(.*)\/realms\/([^/]+)\/?$/.exec(issuer)
  if (!match) throw new Error(`AUTH_KEYCLOAK_ISSUER ${issuer} is not a Keycloak realm issuer`)
  return { baseUrl: match[1], realm: decodeURIComponent(match[2]) }
}

async function adminToken(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }),
  })
  if (!response.ok) {
    throw new Error(`The Keycloak master administrator could not sign in: HTTP ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) throw new Error('The Keycloak token response carries no access_token')
  return body.access_token
}

/** Calls the Admin REST API of the fixture realm at `path`, relative to /admin/realms/{realm}, and throws on an error status. */
async function adminRequest(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Response> {
  const { baseUrl, realm } = realmOfIssuer()
  const response = await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await adminToken(baseUrl)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Keycloak Admin REST ${method} ${path} answered HTTP ${response.status} ${await response.text()}`)
  }
  return response
}

/** The Keycloak sessions of a user of the fixture realm. */
export async function listUserSessions(keycloakId: string): Promise<KeycloakUserSession[]> {
  const response = await adminRequest('GET', `/users/${encodeURIComponent(keycloakId)}/sessions`)
  return (await response.json()) as KeycloakUserSession[]
}

/** Ends every Keycloak session of a user, so that the next sign-in shows the password form again. */
export async function logoutUser(keycloakId: string): Promise<void> {
  await adminRequest('POST', `/users/${encodeURIComponent(keycloakId)}/logout`)
}

/** Ends one Keycloak session of the fixture realm, whose id the ID tokens issued in it carry as `sid`. */
export async function endSession(sessionId: string): Promise<void> {
  await adminRequest('DELETE', `/sessions/${encodeURIComponent(sessionId)}`)
}

/**
 * The path of a user's role mappings on the libredb client, and the representation of one of its roles, which the
 * Admin REST API takes as the body that adds or removes the mapping.
 */
async function libredbRoleMapping(keycloakId: string, role: string): Promise<{ path: string; roles: unknown[] }> {
  const clients = (await (await adminRequest('GET', `/clients?clientId=${ROLE_CLIENT_ID}`)).json()) as {
    id: string
    clientId: string
  }[]
  const client = clients.find(candidate => candidate.clientId === ROLE_CLIENT_ID)
  if (!client) throw new Error(`The fixture realm has no client ${ROLE_CLIENT_ID}`)
  const clientPath = encodeURIComponent(client.id)
  const representation: unknown = await (
    await adminRequest('GET', `/clients/${clientPath}/roles/${encodeURIComponent(role)}`)
  ).json()
  return {
    path: `/users/${encodeURIComponent(keycloakId)}/role-mappings/clients/${clientPath}`,
    roles: [representation],
  }
}

/** Removes the LibreDB role (`admin` or `user`) that the user holds directly. */
export async function removeLibredbRole(keycloakId: string, role: string): Promise<void> {
  const { path, roles } = await libredbRoleMapping(keycloakId, role)
  await adminRequest('DELETE', path, roles)
}

/** Gives the user the LibreDB role (`admin` or `user`) directly; giving a role the user already holds changes nothing. */
export async function assignLibredbRole(keycloakId: string, role: string): Promise<void> {
  const { path, roles } = await libredbRoleMapping(keycloakId, role)
  await adminRequest('POST', path, roles)
}

/** The session lifetimes of the fixture realm, in seconds, under the names of its representation. */
export interface RealmSessionSettings {
  /** SSO Session Idle: how long Keycloak keeps a session that sees no activity. */
  ssoSessionIdleTimeout: number
  /** SSO Session Max: how long Keycloak keeps any session. */
  ssoSessionMaxLifespan: number
}

/** The session lifetimes of the fixture realm. */
export async function getRealmSessionSettings(): Promise<RealmSessionSettings> {
  const realm = (await (await adminRequest('GET', '')).json()) as Partial<Record<keyof RealmSessionSettings, unknown>>
  const { ssoSessionIdleTimeout, ssoSessionMaxLifespan } = realm
  if (typeof ssoSessionIdleTimeout !== 'number' || typeof ssoSessionMaxLifespan !== 'number') {
    throw new Error('The fixture realm carries no ssoSessionIdleTimeout or ssoSessionMaxLifespan')
  }
  return { ssoSessionIdleTimeout, ssoSessionMaxLifespan }
}

/** Changes session lifetimes of the fixture realm; every setting the argument leaves out stays as it is. */
export async function updateRealmSessionSettings(settings: Partial<RealmSessionSettings>): Promise<void> {
  await adminRequest('PUT', '', settings)
}

/** The fields of a client representation that allowPlatformRedirects reads, among the others it sends back unchanged. */
interface ClientRepresentation {
  id: string
  clientId: string
  redirectUris?: string[]
  attributes?: Record<string, string>
}

/**
 * Lets the libredb-platform client of the fixture realm send the browser back to the Platform that `authUrl` names,
 * AUTH_URL by default: adds Platform's Auth.js callback to the client's redirect URIs and its /login page to the
 * post-logout redirect URIs, and keeps every URI the client holds. The realm file allows only http://localhost:3100, so
 * a run whose Platform listens elsewhere, or a spec that starts a second Platform, registers its own URIs here, in the
 * Keycloak that AUTH_KEYCLOAK_ISSUER names.
 */
export async function allowPlatformRedirects(authUrl: string | undefined = process.env.AUTH_URL): Promise<void> {
  if (!authUrl) throw new Error('AUTH_URL must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env')
  const callback = new URL('/api/auth/callback/keycloak', authUrl).toString()
  const postLogout = new URL('/login', authUrl).toString()

  const clients = (await (
    await adminRequest('GET', `/clients?clientId=${encodeURIComponent(PLATFORM_CLIENT_ID)}`)
  ).json()) as ClientRepresentation[]
  const client = clients.find(candidate => candidate.clientId === PLATFORM_CLIENT_ID)
  if (!client) throw new Error(`The fixture realm has no client ${PLATFORM_CLIENT_ID}`)

  const redirectUris = client.redirectUris ?? []
  const postLogoutUris = (client.attributes?.[POST_LOGOUT_REDIRECT_URIS] ?? '').split('##').filter(uri => uri !== '')
  if (redirectUris.includes(callback) && postLogoutUris.includes(postLogout)) return

  await adminRequest('PUT', `/clients/${encodeURIComponent(client.id)}`, {
    ...client,
    redirectUris: redirectUris.includes(callback) ? redirectUris : [...redirectUris, callback],
    attributes: {
      ...client.attributes,
      [POST_LOGOUT_REDIRECT_URIS]: (postLogoutUris.includes(postLogout) ? postLogoutUris : [...postLogoutUris, postLogout]).join('##'),
    },
  })
}
