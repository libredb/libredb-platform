import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeycloakAdminClient } from '../keycloak/admin-client'
import type { KeycloakAdminConfig } from '../keycloak/config'
import { createKeycloakDirectory } from '../keycloak/directory'
import {
  KeycloakAuthError,
  KeycloakNotFoundError,
  KeycloakPermissionError,
  KeycloakUnavailableError,
} from '../keycloak/errors'
import {
  forgetKeycloakSessionRefreshes,
  refreshKeycloakSession,
  type KeycloakSessionRefreshConfig,
} from '../keycloak/token-refresh'
import { logger } from '../logger'
import {
  evaluateSession,
  isRecheckDue,
  recheckSession,
  type RecheckedSession,
  type SessionDirectory,
  type SessionRecheckSettings,
} from './session-recheck'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const CONFIG: KeycloakAdminConfig = {
  realm: 'libredb',
  adminBaseUrl: 'http://keycloak.test:8080/admin/realms/libredb',
  tokenEndpoint: 'http://keycloak.test:8080/realms/libredb/protocol/openid-connect/token',
  clientId: 'libredb-platform',
  clientSecret: 'client-secret-value',
}
const ADMIN_PATH = new URL(CONFIG.adminBaseUrl).pathname
// The refresh goes to the token endpoint of the issuer http://keycloak.test:8080/realms/libredb, which is also where the
// service account gets its token here.
const REFRESH_CONFIG: KeycloakSessionRefreshConfig = {
  tokenEndpoint: CONFIG.tokenEndpoint,
  clientId: CONFIG.clientId,
  clientSecret: CONFIG.clientSecret,
}

// alice of tests/fixtures/keycloak/libredb-test-realm.json, signed in to Platform in the Keycloak session ALICE_SID.
const ROLE_CLIENT_UUID = '332b7468-9076-4a0b-af66-500a15e95788'
const ALICE = '00000000-0000-4000-8000-00000000a11c'
const ALICE_SID = 'b7f1e5a2-0c6d-4f3e-9a51-6f2d8c4e1a90'
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.alice-id-token-payload.alice-id-token-signature'
const REFRESH_TOKEN = 'eyJhbGciOiJIUzUxMiJ9.alice-refresh-token-payload.alice-refresh-token-signature'
const PLATFORM_USER_ID = 'cm2platformuseralice0001'

// The tokens that a refresh of alice's Keycloak session returns, and that a recheck then stores in her session.
const NEW_REFRESH_TOKEN = 'eyJhbGciOiJIUzUxMiJ9.alice-refresh-token-payload-2.alice-refresh-token-signature-2'
const NEW_ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.alice-id-token-payload-2.alice-id-token-signature-2'
const REFRESHED = { refreshToken: NEW_REFRESH_TOKEN, idToken: NEW_ID_TOKEN }

// The defaults of PLATFORM_SESSION_RECHECK_SECONDS and PLATFORM_RECHECK_GRACE_SECONDS.
const SETTINGS: SessionRecheckSettings = { intervalSeconds: 300, graceSeconds: 900 }
const NOW = 1_760_000_000

// One HTTP answer of the fake Keycloak.
interface Answer {
  status: number
  body: string
  contentType: string
}

function json(body: unknown, status = 200): Answer {
  return { status, body: JSON.stringify(body), contentType: 'application/json' }
}

// What an edge in front of Keycloak answers for a path it hides: a 404 without Keycloak's JSON error body.
const EDGE_NOT_FOUND: Answer = { status: 404, body: '<html><body>Not Found</body></html>', contentType: 'text/html' }

function aliceUser(enabled: boolean): Record<string, unknown> {
  return {
    id: ALICE,
    username: 'alice',
    firstName: 'Alice',
    lastName: 'Admin',
    email: 'alice@libredb.test',
    emailVerified: true,
    enabled,
    createdTimestamp: 1792019266505,
    totp: false,
    disableableCredentialTypes: [],
    requiredActions: [],
    notBefore: 0,
  }
}

function clientRoles(...names: string[]): Record<string, unknown>[] {
  return names.map(name => ({ id: `${name}-role-id`, name, composite: false, clientRole: true, containerId: ROLE_CLIENT_UUID }))
}

function userSessions(...ids: string[]): Record<string, unknown>[] {
  return ids.map(id => ({
    id,
    username: 'alice',
    userId: ALICE,
    ipAddress: '172.22.0.1',
    start: 1792019408000,
    lastAccess: 1792019408000,
    rememberMe: false,
    clients: { '37480a5c-61d8-4fb3-8aef-cb75f7e2b988': 'libredb-platform' },
    transientUser: false,
  }))
}

// Keycloak's answer to each request of a recheck of alice, or the failure of that request: the refresh of her session,
// the service account's token and the reads of the Admin API.
interface AliceAnswers {
  refresh: Answer | Error
  token: Answer | Error
  user: Answer | Error
  roles: Answer | Error
  sessions: Answer | Error
}

// As Keycloak 26.8.1 answers the service account of libredb-platform while alice is signed in: she exists, is enabled,
// holds admin and keeps the Keycloak session ALICE_SID.
const SIGNED_IN: AliceAnswers = {
  refresh: json({
    access_token: 'alice-access-token-2',
    expires_in: 300,
    refresh_expires_in: 1800,
    refresh_token: NEW_REFRESH_TOKEN,
    token_type: 'Bearer',
    id_token: NEW_ID_TOKEN,
    'not-before-policy': 0,
    session_state: ALICE_SID,
    scope: 'openid libredb-roles basic acr email profile web-origins roles',
  }),
  token: json({ access_token: 'service-account-access-token', expires_in: 300, token_type: 'Bearer' }),
  user: json(aliceUser(true)),
  roles: json(clientRoles('admin')),
  sessions: json(userSessions(ALICE_SID)),
}

/**
 * The Keycloak directory over its Admin API client, and the session refresh, over a fake Keycloak behind an
 * injected fetch, so a recheck meets the errors those modules raise for each answer. A path without an answer gets
 * Keycloak's 404. It records each request in order: the grant of a token request, or the path of an Admin API read.
 * A new Keycloak has issued no refresh token yet, so the process forgets the refreshes it shares and remembers.
 */
function directoryOf(changes: Partial<AliceAnswers> = {}) {
  forgetKeycloakSessionRefreshes()
  const answers = { ...SIGNED_IN, ...changes }
  const routes: Record<string, Answer | Error> = {
    '/clients': json([{ id: ROLE_CLIENT_UUID, clientId: 'libredb' }]),
    [`/users/${ALICE}`]: answers.user,
    [`/users/${ALICE}/role-mappings/clients/${ROLE_CLIENT_UUID}/composite`]: answers.roles,
    [`/users/${ALICE}/sessions`]: answers.sessions,
  }
  const requests: string[] = []
  const spentRefreshTokens: Array<string | null> = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    let answer: Answer | Error
    if (request.url === CONFIG.tokenEndpoint) {
      const form = new URLSearchParams(await request.text())
      requests.push(`POST ${form.get('grant_type')}`)
      if (form.get('grant_type') === 'refresh_token') spentRefreshTokens.push(form.get('refresh_token'))
      answer = form.get('grant_type') === 'refresh_token' ? answers.refresh : answers.token
    } else {
      const path = new URL(request.url).pathname.slice(ADMIN_PATH.length)
      requests.push(`GET ${path}`)
      answer = routes[path] ?? json({ error: 'Could not find resource' }, 404)
    }
    if (answer instanceof Error) throw answer
    return new Response(answer.body, { status: answer.status, headers: { 'Content-Type': answer.contentType } })
  })
  const directory: SessionDirectory = createKeycloakDirectory(createKeycloakAdminClient(CONFIG, { fetch }))
  const refresh = (refreshToken: string) => refreshKeycloakSession(refreshToken, { config: REFRESH_CONFIG, fetch })
  return { directory, refreshKeycloakSession: refresh, fetch, requests, spentRefreshTokens }
}

type FakeKeycloak = ReturnType<typeof directoryOf>

// alice's Platform session token: the fields the recheck reads and writes, with her tokens, which it must never log.
function sessionOf(overrides: Partial<RecheckedSession> = {}): RecheckedSession {
  return {
    id: PLATFORM_USER_ID,
    keycloakId: ALICE,
    sid: ALICE_SID,
    idToken: ID_TOKEN,
    refreshToken: REFRESH_TOKEN,
    checkedAt: NOW - 300,
    recheckAttemptedAt: NOW - 300,
    directoryDegraded: false,
    ...overrides,
  }
}

function recheck(session: RecheckedSession, keycloak: FakeKeycloak) {
  return recheckSession(session, {
    directory: keycloak.directory,
    refreshKeycloakSession: keycloak.refreshKeycloakSession,
    adminRole: 'admin',
    settings: SETTINGS,
    now: NOW,
  })
}

function evaluate(changes: Partial<AliceAnswers>, session = sessionOf()) {
  return evaluateSession(session, directoryOf(changes).directory, 'admin')
}

// Every argument of every log call, as text, so a test can show that no token value reaches the log.
function loggedText(): string {
  const calls: unknown[] = [logger.debug, logger.info, logger.warn, logger.error].map(log => vi.mocked(log).mock.calls)
  return JSON.stringify(calls, (_key, value: unknown) => (value instanceof Error ? `${value.name}: ${value.message}` : value))
}

const CONTEXT = { userId: PLATFORM_USER_ID, keycloakId: ALICE }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isRecheckDue', () => {
  it('is not due before the interval since the last attempt', async () => {
    expect(isRecheckDue(sessionOf({ checkedAt: NOW - 299, recheckAttemptedAt: NOW - 299 }), NOW, SETTINGS)).toBe(false)
    expect(isRecheckDue(sessionOf({ checkedAt: NOW - 300, recheckAttemptedAt: NOW - 300 }), NOW, SETTINGS)).toBe(true)
    // The interval counts from the last attempt, not from the last success: a degraded session asked 100 s ago waits.
    const degraded = sessionOf({ checkedAt: NOW - 700, recheckAttemptedAt: NOW - 100, directoryDegraded: true })
    expect(isRecheckDue(degraded, NOW, SETTINGS)).toBe(false)

    // A session that is not due comes back unchanged, and Keycloak is not asked.
    const keycloak = directoryOf()
    const session = sessionOf({ checkedAt: NOW - 299, recheckAttemptedAt: NOW - 299 })
    await expect(recheck(session, keycloak)).resolves.toBe(session)
    await expect(recheck(degraded, keycloak)).resolves.toBe(degraded)
    expect(keycloak.fetch).not.toHaveBeenCalled()
  })

  it('a degraded session is due as soon as its grace has passed', () => {
    expect(isRecheckDue(sessionOf({ checkedAt: NOW - 900, recheckAttemptedAt: NOW - 1, directoryDegraded: true }), NOW, SETTINGS))
      .toBe(false)
    expect(isRecheckDue(sessionOf({ checkedAt: NOW - 901, recheckAttemptedAt: NOW - 1, directoryDegraded: true }), NOW, SETTINGS))
      .toBe(true)
  })
})

describe('evaluateSession and recheckSession', () => {
  it('a session that Keycloak still backs is valid, refreshes checkedAt and the last attempt, and ends a degraded state', async () => {
    await expect(evaluate({})).resolves.toEqual({ status: 'valid' })
    // The role may come with others, directly or through a group.
    await expect(evaluate({ roles: json(clientRoles('user', 'admin')) })).resolves.toEqual({ status: 'valid' })

    const degraded = sessionOf({ checkedAt: NOW - 600, recheckAttemptedAt: NOW - 300, directoryDegraded: true })
    await expect(recheck(degraded, directoryOf())).resolves.toEqual({
      ...degraded,
      ...REFRESHED,
      checkedAt: NOW,
      recheckAttemptedAt: NOW,
      directoryDegraded: false,
    })
  })

  it('revokes with user-missing on KeycloakNotFoundError', async () => {
    // Keycloak answers its own JSON 404 to GET /users/{id} for a deleted user, which the client raises as
    // KeycloakNotFoundError and the directory reads as no user.
    const deleted: Partial<AliceAnswers> = { user: json({ error: 'User not found' }, 404) }

    await expect(evaluate(deleted)).resolves.toEqual({ status: 'revoked', reason: 'user-missing' })
    await expect(recheck(sessionOf(), directoryOf(deleted))).resolves.toBeNull()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('ended'), { ...CONTEXT, reason: 'user-missing' })
  })

  it('a KeycloakNotFoundError from a read other than GET /users/{id} is never read as user-missing', async () => {
    // Keycloak answers the same JSON 404 for a client it does not know and for a route it does not have.
    for (const changes of [
      { roles: json({ error: 'Client not found' }, 404) },
      { sessions: json({ error: 'HTTP 404 Not Found' }, 404) },
    ]) {
      await expect(evaluate(changes)).rejects.toThrow(KeycloakNotFoundError)
      await expect(recheck(sessionOf(), directoryOf(changes))).rejects.toThrow(KeycloakNotFoundError)
    }
  })

  it('revokes with user-disabled', async () => {
    const disabled: Partial<AliceAnswers> = { user: json(aliceUser(false)) }

    await expect(evaluate(disabled)).resolves.toEqual({ status: 'revoked', reason: 'user-disabled' })
    await expect(recheck(sessionOf(), directoryOf(disabled))).resolves.toBeNull()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('ended'), { ...CONTEXT, reason: 'user-disabled' })
  })

  it('revokes with role-removed', async () => {
    for (const roles of [clientRoles('user'), clientRoles(), clientRoles('Admin', 'administrator')]) {
      await expect(evaluate({ roles: json(roles) })).resolves.toEqual({ status: 'revoked', reason: 'role-removed' })
    }
    await expect(recheck(sessionOf(), directoryOf({ roles: json(clientRoles('user')) }))).resolves.toBeNull()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('ended'), { ...CONTEXT, reason: 'role-removed' })

    // The role is the one PLATFORM_ADMIN_ROLE names.
    const dba = evaluateSession(sessionOf(), directoryOf({ roles: json(clientRoles('dba')) }).directory, 'dba')
    await expect(dba).resolves.toEqual({ status: 'valid' })
  })

  it('revokes with session-ended when the sid is gone', async () => {
    for (const sessions of [userSessions('5d3c1b2a-9e8f-4a7b-8c6d-0e1f2a3b4c5d'), userSessions()]) {
      await expect(evaluate({ sessions: json(sessions) })).resolves.toEqual({ status: 'revoked', reason: 'session-ended' })
    }
    // A token without sid cannot show that its Keycloak session still exists.
    await expect(evaluate({}, sessionOf({ sid: null }))).resolves.toEqual({ status: 'revoked', reason: 'session-ended' })

    await expect(recheck(sessionOf(), directoryOf({ sessions: json(userSessions()) }))).resolves.toBeNull()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('ended'), { ...CONTEXT, reason: 'session-ended' })
  })

  it('an unreachable Admin API keeps the session degraded within 900 s of the last success', async () => {
    const unreachable: Partial<AliceAnswers>[] = [
      { user: new TypeError('fetch failed') },
      // A 404 without a Keycloak JSON body is an unreachable directory, never a deleted user.
      { user: EDGE_NOT_FOUND },
      { token: json({ error: 'temporarily_unavailable' }, 503) },
      { roles: { status: 502, body: 'Bad Gateway', contentType: 'text/plain' } },
      { sessions: json({ error: 'unknown_error' }, 500) },
    ]

    for (const changes of unreachable) {
      await expect(evaluate(changes)).resolves.toEqual({ status: 'unreachable', error: expect.any(KeycloakUnavailableError) })

      for (const checkedAt of [NOW - 300, NOW - 900]) {
        const session = sessionOf({ checkedAt, recheckAttemptedAt: NOW - 300 })
        await expect(recheck(session, directoryOf(changes))).resolves.toEqual({
          ...session,
          ...REFRESHED,
          recheckAttemptedAt: NOW,
          directoryDegraded: true,
        })
      }
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unreachable'), { ...CONTEXT, error: expect.any(String) })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('KeycloakAuthError and KeycloakPermissionError keep the session degraded and are logged as configuration errors', async () => {
    const refused: Array<[Partial<AliceAnswers>, typeof KeycloakAuthError | typeof KeycloakPermissionError]> = [
      [{ token: json({ error: 'unauthorized_client', error_description: 'Invalid client secret' }, 401) }, KeycloakAuthError],
      [{ user: json({ error: 'HTTP 403 Forbidden' }, 403) }, KeycloakPermissionError],
      [{ sessions: json({ error: 'HTTP 403 Forbidden' }, 403) }, KeycloakPermissionError],
    ]

    for (const [changes, errorClass] of refused) {
      await expect(evaluate(changes)).resolves.toEqual({ status: 'unreachable', error: expect.any(errorClass) })

      const session = sessionOf()
      await expect(recheck(session, directoryOf(changes))).resolves.toEqual({
        ...session,
        ...REFRESHED,
        recheckAttemptedAt: NOW,
        directoryDegraded: true,
      })
      expect(logger.error).toHaveBeenLastCalledWith(expect.stringContaining('configuration'), expect.any(errorClass), CONTEXT)
    }
  })

  it('an unreachable Admin API after the grace ends the session', async () => {
    const down: Partial<AliceAnswers> = { user: new TypeError('fetch failed') }

    // A degraded session asks once more when its grace has passed, and ends when Keycloak still does not answer.
    const degraded = sessionOf({ checkedAt: NOW - 901, recheckAttemptedAt: NOW - 1, directoryDegraded: true })
    await expect(recheck(degraded, directoryOf(down))).resolves.toBeNull()

    // A session whose last success is older than the grace ends at its first unanswered recheck.
    const idle = sessionOf({ checkedAt: NOW - 1200, recheckAttemptedAt: NOW - 1200 })
    await expect(recheck(idle, directoryOf(down))).resolves.toBeNull()
    await expect(recheck(idle, directoryOf({ user: json({ error: 'HTTP 403 Forbidden' }, 403) }))).resolves.toBeNull()

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('grace'), { ...CONTEXT, graceSeconds: 900 })

    // A Keycloak that answers again before the session ends keeps it.
    await expect(recheck(degraded, directoryOf())).resolves.toEqual({
      ...degraded,
      ...REFRESHED,
      checkedAt: NOW,
      recheckAttemptedAt: NOW,
      directoryDegraded: false,
    })
  })

  it('logs every verdict without the ID token or the Keycloak session id', async () => {
    for (const changes of [
      { user: json({ error: 'User not found' }, 404) },
      { user: json(aliceUser(false)) },
      { roles: json(clientRoles()) },
      { sessions: json(userSessions()) },
      { user: EDGE_NOT_FOUND },
      { user: json({ error: 'HTTP 403 Forbidden' }, 403) },
    ]) {
      await recheck(sessionOf(), directoryOf(changes))
      await recheck(sessionOf({ checkedAt: NOW - 1000 }), directoryOf(changes))
    }

    const logged = loggedText()
    expect(logged).toContain('user-missing')
    for (const secret of [ID_TOKEN, ALICE_SID, REFRESH_TOKEN, NEW_REFRESH_TOKEN, NEW_ID_TOKEN]) {
      expect(logged).not.toContain(secret)
    }
  })
})

describe('the Keycloak session refresh of a recheck', () => {
  it('a due recheck refreshes the Keycloak session before the Admin API checks and stores the new tokens', async () => {
    const keycloak = directoryOf()
    const session = sessionOf()

    await expect(recheck(session, keycloak)).resolves.toEqual({
      ...session,
      refreshToken: NEW_REFRESH_TOKEN,
      idToken: NEW_ID_TOKEN,
      checkedAt: NOW,
      recheckAttemptedAt: NOW,
      directoryDegraded: false,
    })
    // The refresh spends the session's refresh token, so Keycloak counts the session as active before the Admin API is
    // asked whether it still exists.
    expect(keycloak.spentRefreshTokens).toEqual([REFRESH_TOKEN])
    expect(keycloak.requests[0]).toBe('POST refresh_token')
    expect(keycloak.requests).toContain(`GET /users/${ALICE}/sessions`)
    expect(keycloak.requests.filter(request => request === 'POST refresh_token')).toHaveLength(1)

    // A directory that cannot be read keeps the session degraded with the new tokens, because a realm that revokes
    // refresh tokens no longer accepts the old one.
    const unreachable = directoryOf({ sessions: json({ error: 'unknown_error' }, 500) })
    await expect(recheck(session, unreachable)).resolves.toEqual({
      ...session,
      ...REFRESHED,
      recheckAttemptedAt: NOW,
      directoryDegraded: true,
    })
    // The refresh never keeps a session that the Admin API checks end.
    await expect(recheck(session, directoryOf({ roles: json(clientRoles('user')) }))).resolves.toBeNull()
  })

  it('a refused refresh is logged without the token, and the Admin API checks still decide the verdict', async () => {
    const failures: Array<Answer | Error> = [
      // The Keycloak session expired or ended, or the realm revokes refresh tokens and this one was used already.
      json({ error: 'invalid_grant', error_description: 'Session not active' }, 400),
      // Keycloak refused Platform's client credentials.
      json({ error: 'unauthorized_client', error_description: 'Invalid client or Invalid client credentials' }, 401),
      new TypeError('fetch failed'),
    ]

    for (const refresh of failures) {
      const session = sessionOf()
      // Keycloak still has the session: it goes on with the tokens it had.
      await expect(recheck(session, directoryOf({ refresh }))).resolves.toEqual({
        ...session,
        checkedAt: NOW,
        recheckAttemptedAt: NOW,
        directoryDegraded: false,
      })
      // Keycloak no longer has the session: the session-ended verdict ends it.
      await expect(recheck(session, directoryOf({ refresh, sessions: json(userSessions()) }))).resolves.toBeNull()
      expect(logger.info).toHaveBeenLastCalledWith(expect.stringContaining('ended'), { ...CONTEXT, reason: 'session-ended' })
      // The Admin API cannot be read: the grace decides, as without the refresh.
      await expect(recheck(session, directoryOf({ refresh, user: new TypeError('fetch failed') }))).resolves.toEqual({
        ...session,
        recheckAttemptedAt: NOW,
        directoryDegraded: true,
      })
      await expect(recheck(sessionOf({ checkedAt: NOW - 1000 }), directoryOf({ refresh, user: new TypeError('fetch failed') })))
        .resolves.toBeNull()
    }

    // An error that is none of Keycloak's answers does not decide the verdict either.
    const session = sessionOf()
    const broken = directoryOf()
    const verdict = recheckSession(session, {
      directory: broken.directory,
      refreshKeycloakSession: async () => {
        throw new Error('the refresh failed unexpectedly')
      },
      adminRole: 'admin',
      settings: SETTINGS,
      now: NOW,
    })
    await expect(verdict).resolves.toEqual({ ...session, checkedAt: NOW, recheckAttemptedAt: NOW, directoryDegraded: false })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/refresh.*refused/), { ...CONTEXT, error: expect.any(String) })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/refresh.*unreachable/), { ...CONTEXT, error: expect.any(String) })
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/refresh.*configuration/), expect.any(KeycloakAuthError), CONTEXT)
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/refresh.*unexpected/), expect.any(Error), CONTEXT)
    const logged = loggedText()
    for (const secret of [REFRESH_TOKEN, ID_TOKEN, ALICE_SID]) {
      expect(logged).not.toContain(secret)
    }
  })
})
