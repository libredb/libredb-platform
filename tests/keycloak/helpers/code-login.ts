import { createHash, randomBytes } from 'node:crypto'

// Authorization-code login with PKCE against the test realm of
// tests/fixtures/keycloak/libredb-test-realm.json, without a browser: it opens
// the authorization endpoint, submits Keycloak's login form and redeems the
// code, so integration tests get real tokens issued for a real login.

export const TEST_REALM = 'libredb'
export const TEST_PASSWORD = 'libredb-test-password'

export const TEST_CLIENTS = {
  platform: {
    clientId: 'libredb-platform',
    clientSecret: 'libredb-platform-test-secret',
    redirectUri: 'http://localhost:3100/api/auth/callback/keycloak',
  },
  studio: {
    clientId: 'libredb-studio',
    clientSecret: 'libredb-studio-test-secret',
    redirectUri: 'http://localhost:3200/api/auth/oidc/callback',
  },
} as const

export type TestClient = (typeof TEST_CLIENTS)[keyof typeof TEST_CLIENTS]

// The ports default to the ones docker-compose.test.yml publishes.
export const KEYCLOAK_URL = `http://localhost:${process.env.TEST_KEYCLOAK_PORT ?? '58080'}`
export const KEYCLOAK_PROXIED_URL = `http://localhost:${process.env.TEST_KEYCLOAK_PROXIED_PORT ?? '58081'}`

export interface TokenSet {
  access_token: string
  id_token: string
  refresh_token?: string
  token_type: string
  expires_in: number
}

export interface CodeLoginOptions {
  baseUrl?: string
  realm?: string
  client?: TestClient
  username: string
  password?: string
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }

// Decodes the entities of HTML_ENTITIES in one pass, so the & that &amp; decodes to never starts another entity:
// &amp;lt; decodes to &lt;, not to <.
export function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|#39|lt|gt);/g, entity => HTML_ENTITIES[entity])
}

// Keeps the latest value of every cookie Keycloak sets during the login.
class CookieJar {
  private readonly cookies = new Map<string, string>()

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0]
      const separator = pair.indexOf('=')
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

function loginFormAction(html: string): string {
  const form = html.match(/<form\b[^>]*\bid="kc-form-login"[^>]*>/)
  if (!form) throw new Error('Keycloak login page has no form kc-form-login')
  const action = form[0].match(/\baction="([^"]+)"/)
  if (!action) throw new Error('Keycloak login form has no action')
  return decodeHtmlAttribute(action[1])
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Not a compact JWT')
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
}

export async function codeLogin(options: CodeLoginOptions): Promise<TokenSet> {
  const baseUrl = options.baseUrl ?? KEYCLOAK_URL
  const realm = options.realm ?? TEST_REALM
  const client = options.client ?? TEST_CLIENTS.platform
  const password = options.password ?? TEST_PASSWORD
  const oidc = `${baseUrl}/realms/${realm}/protocol/openid-connect`

  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = base64Url(randomBytes(16))
  const nonce = base64Url(randomBytes(16))
  const jar = new CookieJar()

  const authorize = new URL(`${oidc}/auth`)
  authorize.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()

  const loginPage = await fetch(authorize, { redirect: 'manual' })
  jar.store(loginPage)
  if (loginPage.status !== 200) {
    throw new Error(`Authorization endpoint answered ${loginPage.status}, expected the login page`)
  }
  const action = loginFormAction(await loginPage.text())

  const submitted = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: new URLSearchParams({ username: options.username, password, credentialId: '' }),
  })
  const location = submitted.headers.get('location')
  if (submitted.status !== 302 || !location || !location.startsWith(client.redirectUri)) {
    throw new Error(
      `Login of ${options.username} answered ${submitted.status} without a redirect to ${client.redirectUri}`,
    )
  }
  const callback = new URL(location)
  if (callback.searchParams.get('state') !== state) throw new Error('Callback state does not match')
  const error = callback.searchParams.get('error')
  if (error) throw new Error(`Login of ${options.username} failed: ${error}`)
  const code = callback.searchParams.get('code')
  if (!code) throw new Error('Callback carries no code')

  const tokenResponse = await fetch(`${oidc}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      code_verifier: verifier,
    }),
  })
  if (!tokenResponse.ok) {
    throw new Error(`Token endpoint answered ${tokenResponse.status}: ${await tokenResponse.text()}`)
  }
  const tokens = (await tokenResponse.json()) as TokenSet
  if (decodeJwtPayload(tokens.id_token).nonce !== nonce) throw new Error('ID token nonce does not match')
  return tokens
}

export async function clientCredentialsToken(
  baseUrl: string,
  client: TestClient = TEST_CLIENTS.platform,
  realm: string = TEST_REALM,
): Promise<string> {
  const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  })
  if (!response.ok) {
    throw new Error(`Token endpoint answered ${response.status}: ${await response.text()}`)
  }
  return ((await response.json()) as { access_token: string }).access_token
}
