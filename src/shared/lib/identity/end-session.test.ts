import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEndSessionUrl, getEndSessionEndpoint } from './end-session'

const fetchMock = vi.fn<typeof fetch>()

function discovery(document: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(document), { status, headers: { 'content-type': 'application/json' } })
}

// Each test uses its own issuer, because the module caches the discovery document per issuer.
let issuerCount = 0
function nextIssuer(): string {
  issuerCount += 1
  return `http://keycloak-${issuerCount}.test/realms/libredb`
}

describe('buildEndSessionUrl', () => {
  it('builds the URL with id_token_hint, post_logout_redirect_uri and client_id', () => {
    const url = new URL(
      buildEndSessionUrl({
        endpoint: 'https://auth.libredb.test/realms/libredb/protocol/openid-connect/logout',
        idToken: 'header.payload.signature',
        postLogoutRedirectUri: 'https://platform.libredb.test/login',
        clientId: 'libredb-platform',
      }),
    )

    expect(url.origin + url.pathname).toBe('https://auth.libredb.test/realms/libredb/protocol/openid-connect/logout')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id_token_hint: 'header.payload.signature',
      post_logout_redirect_uri: 'https://platform.libredb.test/login',
      client_id: 'libredb-platform',
    })
  })
})

describe('getEndSessionEndpoint', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads end_session_endpoint from the discovery document of the issuer', async () => {
    const issuer = nextIssuer()
    fetchMock.mockResolvedValue(discovery({ issuer, end_session_endpoint: `${issuer}/protocol/openid-connect/logout` }))

    await expect(getEndSessionEndpoint(issuer)).resolves.toBe(`${issuer}/protocol/openid-connect/logout`)
    expect(fetchMock).toHaveBeenCalledWith(`${issuer}/.well-known/openid-configuration`, expect.anything())
  })

  it('throws when the discovery document has no end_session_endpoint', async () => {
    const issuer = nextIssuer()
    fetchMock.mockResolvedValue(discovery({ issuer }))

    await expect(getEndSessionEndpoint(issuer)).rejects.toThrow(/end_session_endpoint/)
  })

  it('throws when the discovery request fails', async () => {
    const issuer = nextIssuer()
    fetchMock.mockResolvedValue(discovery({ error: 'not found' }, 404))

    await expect(getEndSessionEndpoint(issuer)).rejects.toThrow(/404/)
  })

  it('caches the endpoint for 300 seconds', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-15T08:00:00.000Z') })
    const issuer = nextIssuer()
    fetchMock.mockImplementation(async () => discovery({ end_session_endpoint: `${issuer}/logout` }))

    await getEndSessionEndpoint(issuer)
    vi.advanceTimersByTime(299_000)
    await getEndSessionEndpoint(issuer)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1_000)
    await getEndSessionEndpoint(issuer)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed discovery', async () => {
    const issuer = nextIssuer()
    fetchMock.mockResolvedValueOnce(discovery({}, 503))
    fetchMock.mockResolvedValueOnce(discovery({ end_session_endpoint: `${issuer}/logout` }))

    await expect(getEndSessionEndpoint(issuer)).rejects.toThrow()
    await expect(getEndSessionEndpoint(issuer)).resolves.toBe(`${issuer}/logout`)
  })
})
