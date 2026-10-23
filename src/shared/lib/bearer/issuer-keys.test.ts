// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { errors, exportJWK, generateKeyPair, SignJWT, jwtVerify, type JWK } from 'jose'
import { IdentityProviderUnavailableError } from './errors'
import { createIssuerKeys } from './issuer-keys'

// A local identity provider that serves the discovery document and the JWKS, and counts the requests of each.

interface Provider {
  discoveryStatus: number
  jwksStatus: number
  jwks: { keys: JWK[] }
  requests: string[]
}

const provider: Provider = { discoveryStatus: 200, jwksStatus: 200, jwks: { keys: [] }, requests: [] }
let server: Server
let issuer: string
let privateKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  provider.jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }] }

  server = createServer((request, response) => {
    provider.requests.push(request.url ?? '')
    if (request.url === '/realms/libredb/.well-known/openid-configuration') {
      response.writeHead(provider.discoveryStatus, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/protocol/openid-connect/certs` }))
      return
    }
    if (request.url === '/realms/libredb/protocol/openid-connect/certs') {
      response.writeHead(provider.jwksStatus, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(provider.jwks))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/libredb`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

beforeEach(() => {
  provider.discoveryStatus = 200
  provider.jwksStatus = 200
  provider.requests = []
})

function sign(kid = 'key-1'): Promise<string> {
  return new SignJWT({ sub: 'kc-alice' }).setProtectedHeader({ alg: 'RS256', kid }).setExpirationTime('5m').sign(privateKey)
}

describe('createIssuerKeys', () => {
  it('finds the JWKS through the discovery document of the issuer and reads each of them once', async () => {
    const keys = createIssuerKeys(issuer)

    await expect(jwtVerify(await sign(), keys)).resolves.toMatchObject({ payload: { sub: 'kc-alice' } })
    await expect(jwtVerify(await sign(), keys)).resolves.toMatchObject({ payload: { sub: 'kc-alice' } })

    expect(provider.requests).toEqual([
      '/realms/libredb/.well-known/openid-configuration',
      '/realms/libredb/protocol/openid-connect/certs',
    ])
  })

  it('answers IdentityProviderUnavailableError when the discovery document cannot be read, and retries on the next call', async () => {
    const keys = createIssuerKeys(issuer)
    provider.discoveryStatus = 503

    await expect(jwtVerify(await sign(), keys)).rejects.toBeInstanceOf(IdentityProviderUnavailableError)

    provider.discoveryStatus = 200
    await expect(jwtVerify(await sign(), keys)).resolves.toMatchObject({ payload: { sub: 'kc-alice' } })
  })

  it('answers IdentityProviderUnavailableError when the JWKS cannot be read', async () => {
    const keys = createIssuerKeys(issuer)
    provider.jwksStatus = 500

    await expect(jwtVerify(await sign(), keys)).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })

  it('answers IdentityProviderUnavailableError when the issuer does not answer at all', async () => {
    const keys = createIssuerKeys('http://127.0.0.1:1/realms/libredb')

    await expect(jwtVerify(await sign(), keys)).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })

  it('passes on the refusal of a key the issuer does not publish, which is a token problem', async () => {
    const keys = createIssuerKeys(issuer)

    await expect(jwtVerify(await sign('key-unknown'), keys)).rejects.toBeInstanceOf(errors.JWKSNoMatchingKey)
  })
})
