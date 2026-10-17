import { sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  LICENSE_TEST_KEY,
  OTHER_LICENSE_TEST_KEY,
  signedMessage,
  signLicense,
} from '../../../../tests/license/test-keys'
import { LICENSE_ERROR_CODES, type LicenseErrorCode } from './errors'
import { LICENSE_KEYS } from './keys'
import { licenseKeyring, verifyLicenseToken, type LicensePayload } from './token'

const KEYRING = licenseKeyring([{ kid: LICENSE_TEST_KEY.kid, publicKey: LICENSE_TEST_KEY.publicKey }])
const HOST = 'platform.example.com'

// Hosts of 253 characters, the longest a hostname may be, and of 254, each of labels of at most 63 characters.
const LONGEST_HOST = ['a', 'b', 'c'].map((letter) => letter.repeat(63)).concat('d'.repeat(61)).join('.')
const TOO_LONG_HOST = `${LONGEST_HOST}d`

// A license issued 2026-10-16 and expiring 2027-10-16, bound to no host.
const UNBOUND = {
  v: 1,
  id: 'LIC-2026.0042_eu',
  customer: 'Example Customer A.Ş.',
  adminSeats: 2,
  userSeats: 25,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
} satisfies LicensePayload

// The same license with every field of the format: bound to two hosts.
const PAYLOAD = { ...UNBOUND, hosts: [HOST, 'platform.example.internal'] } satisfies LicensePayload

function verifyFor(token: string, host: string | null = HOST) {
  return verifyLicenseToken(token, { keyring: KEYRING, host })
}

// The failure code of a token, or 'valid'.
function codeOf(token: string, host: string | null = HOST): LicenseErrorCode | 'valid' {
  const result = verifyFor(token, host)
  return result.ok ? 'valid' : result.code
}

function segments(token: string): string[] {
  return token.split('.')
}

function withSegment(token: string, index: number, value: string): string {
  const parts = segments(token)
  parts[index] = value
  return parts.join('.')
}

function assemble(kid: string, payload: Uint8Array, signature: Uint8Array): string {
  return ['ldl1', kid, Buffer.from(payload).toString('base64url'), Buffer.from(signature).toString('base64url')].join('.')
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// The same bytes with the unused low bits of the last character set, which a lenient decoder ignores.
function withUnusedBitsSet(segment: string): string {
  const last = BASE64URL_ALPHABET.indexOf(segment.slice(-1))
  return segment.slice(0, -1) + BASE64URL_ALPHABET[last | 1]
}

// A token whose signature segment holds only the first 63 bytes of its signature.
function withShortSignature(token: string): string {
  return withSegment(token, 3, Buffer.from(segments(token)[3], 'base64url').subarray(0, 63).toString('base64url'))
}

describe('verifyLicenseToken', () => {
  it('verifies a token signed by a test key and returns every payload field', () => {
    expect(verifyFor(signLicense(LICENSE_TEST_KEY, PAYLOAD))).toEqual({ ok: true, license: PAYLOAD })
    expect(verifyFor(signLicense(LICENSE_TEST_KEY, PAYLOAD), 'platform.example.internal')).toEqual({
      ok: true,
      license: PAYLOAD,
    })
  })

  it('verifies a license without hosts on any host, and one whose issue date is still to come', () => {
    const token = signLicense(LICENSE_TEST_KEY, UNBOUND)
    expect(verifyFor(token, 'any.example.org')).toEqual({ ok: true, license: UNBOUND })
    expect(verifyFor(token, null)).toEqual({ ok: true, license: UNBOUND })

    // Expiry is a state of the license, not a verification failure, so verification reads no clock.
    const future = { ...UNBOUND, issuedAt: 4_000_000_000, expiresAt: 4_100_000_000 }
    expect(verifyFor(signLicense(LICENSE_TEST_KEY, future))).toEqual({ ok: true, license: future })
  })

  it('verifies the exact payload bytes that were signed, whatever their JSON layout', () => {
    // Spaces, line breaks, another key order and an escaped letter: a verifier that serialized the payload again
    // would check other bytes than the signed ones.
    const text =
      '{\n  "expiresAt": 1823644800, "issuedAt": 1792108800,\n  "userSeats": 25, "adminSeats": 2,\n' +
      '  "customer": "Example \\u0043ustomer", "id": "LIC-1", "v": 1\n}'
    expect(verifyFor(signLicense(LICENSE_TEST_KEY, Buffer.from(text, 'utf8')))).toEqual({
      ok: true,
      license: { ...UNBOUND, id: 'LIC-1', customer: 'Example Customer' },
    })
  })

  it('accepts every field at the edges of its range', () => {
    expect(LONGEST_HOST).toHaveLength(253)
    const edges: Array<[string, LicensePayload]> = [
      ['no seats', { ...PAYLOAD, adminSeats: 0, userSeats: 0 }],
      ['the most seats', { ...PAYLOAD, adminSeats: 100_000, userSeats: 1_000_000 }],
      ['the shortest id and customer', { ...PAYLOAD, id: 'a', customer: 'C' }],
      ['the longest id and customer', { ...PAYLOAD, id: 'A'.repeat(64), customer: 'C'.repeat(200) }],
      ['every character an id may hold', { ...PAYLOAD, id: 'AZaz09._-' }],
      ['20 hosts', { ...PAYLOAD, hosts: [HOST, ...Array.from({ length: 19 }, (_, n) => `host-${n}.example.com`)] }],
      [
        'a host of one label, an IPv4 address and an IDNA host',
        { ...PAYLOAD, hosts: [HOST, 'platform', '10.0.0.5', 'xn--bcher-kva.example'] },
      ],
      [
        'a label of 63 characters and a host of 253',
        { ...PAYLOAD, hosts: [HOST, `${'a'.repeat(63)}.example.com`, LONGEST_HOST] },
      ],
      ['the first second of 1970', { ...PAYLOAD, issuedAt: 0, expiresAt: 1 }],
      ['the last second of 9999', { ...PAYLOAD, expiresAt: 253_402_300_799 }],
    ]
    for (const [name, payload] of edges) {
      expect(verifyFor(signLicense(LICENSE_TEST_KEY, payload)), name).toEqual({ ok: true, license: payload })
    }
  })

  it('refuses a wrong prefix with LICENSE_MALFORMED', () => {
    const token = signLicense(LICENSE_TEST_KEY, PAYLOAD)
    for (const prefix of ['ldl2', 'LDL1', 'lsb1', 'ldl', '', ' ldl1']) {
      expect(codeOf(withSegment(token, 0, prefix)), `prefix ${JSON.stringify(prefix)}`).toBe('LICENSE_MALFORMED')
    }
  })

  it('refuses a wrong number of segments with LICENSE_MALFORMED', () => {
    const token = signLicense(LICENSE_TEST_KEY, PAYLOAD)
    const [prefix, kid, payload, signature] = segments(token)
    const cases: Array<[string, string]> = [
      ['an empty text', ''],
      ['the prefix alone', prefix],
      ['no signature', [prefix, kid, payload].join('.')],
      ['no kid', [prefix, payload, signature].join('.')],
      ['five segments', `${token}.${signature}`],
      ['a trailing dot', `${token}.`],
    ]
    for (const [name, text] of cases) {
      expect(codeOf(text), name).toBe('LICENSE_MALFORMED')
    }
  })

  it('refuses a segment that is not in its canonical encoding with LICENSE_MALFORMED', () => {
    const token = signLicense(LICENSE_TEST_KEY, PAYLOAD)
    const [, kid, payload, signature] = segments(token)
    expect(kid).toMatch(/[a-f]/)
    const unusedBits = withUnusedBitsSet(signature)
    expect(Buffer.from(unusedBits, 'base64url')).toEqual(Buffer.from(signature, 'base64url'))

    const cases: Array<[string, number, string]> = [
      ['an uppercase kid', 1, kid.toUpperCase()],
      ['a kid of 15 digits', 1, kid.slice(1)],
      ['a kid of 17 digits', 1, `${kid}0`],
      ['a kid that is not hex', 1, `${kid.slice(1)}g`],
      ['a padded payload', 2, `${payload}=`],
      ['a payload with a line break', 2, `${payload.slice(0, 8)}\n${payload.slice(8)}`],
      ['a payload with a space', 2, ` ${payload}`],
      ['a padded signature', 3, `${signature}==`],
      ['a signature whose unused bits are set', 3, unusedBits],
      ['a signature with a trailing line break', 3, `${signature}\n`],
    ]
    for (const [name, index, value] of cases) {
      expect(codeOf(withSegment(token, index, value)), name).toBe('LICENSE_MALFORMED')
    }

    // The bytes fb ff bf are `-_-_` in base64url and `+/+/` in standard base64, which Node's decoder also reads:
    // signed, the canonical spelling passes every check up to the payload, and the other spelling is malformed.
    const bytes = Buffer.from([0xfb, 0xff, 0xbf])
    const signedBytes = sign(null, signedMessage(kid, bytes), LICENSE_TEST_KEY.privateKey)
    const canonical = assemble(kid, bytes, signedBytes)
    expect(segments(canonical)[2]).toBe('-_-_')
    expect(codeOf(canonical)).toBe('LICENSE_PAYLOAD_INVALID')
    expect(codeOf(withSegment(canonical, 2, '+/+/'))).toBe('LICENSE_MALFORMED')
  })

  it('refuses a kid that names no key of the list with LICENSE_UNKNOWN_KID', () => {
    expect(codeOf(signLicense(OTHER_LICENSE_TEST_KEY, PAYLOAD))).toBe('LICENSE_UNKNOWN_KID')
    expect(codeOf(withSegment(signLicense(LICENSE_TEST_KEY, PAYLOAD), 1, '0123456789abcdef'))).toBe('LICENSE_UNKNOWN_KID')

    // The production list holds no test key, so a token signed by one names an unknown kid there.
    const production = licenseKeyring(LICENSE_KEYS)
    expect(verifyLicenseToken(signLicense(LICENSE_TEST_KEY, PAYLOAD), { keyring: production, host: HOST })).toEqual({
      ok: false,
      code: 'LICENSE_UNKNOWN_KID',
    })
  })

  it('refuses a signature that is not 64 bytes with LICENSE_MALFORMED', () => {
    const token = signLicense(LICENSE_TEST_KEY, PAYLOAD)
    const signature = Buffer.from(segments(token)[3], 'base64url')
    expect(signature).toHaveLength(64)
    expect(codeOf(withShortSignature(token))).toBe('LICENSE_MALFORMED')
    for (const resized of [Buffer.concat([signature, Buffer.of(0)]), signature.subarray(0, 32), Buffer.alloc(0)]) {
      expect(codeOf(withSegment(token, 3, resized.toString('base64url'))), `${resized.length} bytes`).toBe(
        'LICENSE_MALFORMED',
      )
    }
  })

  it('refuses a signature that does not verify with LICENSE_BAD_SIGNATURE', () => {
    const token = signLicense(LICENSE_TEST_KEY, PAYLOAD)
    const [, kid, , signature] = segments(token)
    const bytes = json(PAYLOAD)
    const flipped = Buffer.from(signature, 'base64url')
    flipped[10] ^= 0x01

    const cases: Array<[string, string]> = [
      ['a signature by another key under this kid', signLicense(OTHER_LICENSE_TEST_KEY, PAYLOAD, kid)],
      ['a signature with one bit flipped', withSegment(token, 3, flipped.toString('base64url'))],
      [
        'a payload changed after signing',
        withSegment(token, 2, json({ ...PAYLOAD, userSeats: 1_000 }).toString('base64url')),
      ],
      [
        'a signature over another kid',
        assemble(kid, bytes, sign(null, signedMessage(OTHER_LICENSE_TEST_KEY.kid, bytes), LICENSE_TEST_KEY.privateKey)),
      ],
      ['a signature over the payload alone', assemble(kid, bytes, sign(null, bytes, LICENSE_TEST_KEY.privateKey))],
      ['a signature of 64 zero bytes', withSegment(token, 3, Buffer.alloc(64).toString('base64url'))],
      ['a signature of 64 bytes 0xff', withSegment(token, 3, Buffer.alloc(64, 0xff).toString('base64url'))],
    ]
    for (const [name, forged] of cases) {
      expect(codeOf(forged), name).toBe('LICENSE_BAD_SIGNATURE')
    }
  })

  it('refuses a signed payload that is not a valid version 1 license with LICENSE_PAYLOAD_INVALID', () => {
    expect(TOO_LONG_HOST).toHaveLength(254)
    const fields = ['v', 'id', 'customer', 'adminSeats', 'userSeats', 'issuedAt', 'expiresAt'] as const
    const without = (field: (typeof fields)[number]) =>
      Object.fromEntries(Object.entries(PAYLOAD).filter(([key]) => key !== field))
    const cases: Array<[string, unknown]> = [
      ...fields.map((field): [string, unknown] => [`no ${field}`, without(field)]),
      ['an unknown field', { ...PAYLOAD, tier: 'enterprise' }],
      ['version 2', { ...PAYLOAD, v: 2 }],
      ['the version as text', { ...PAYLOAD, v: '1' }],
      ['admin seats as text', { ...PAYLOAD, adminSeats: '2' }],
      ['a fractional user seat count', { ...PAYLOAD, userSeats: 2.5 }],
      ['a fractional issuedAt', { ...PAYLOAD, issuedAt: 1_792_108_800.5 }],
      ['a null expiresAt', { ...PAYLOAD, expiresAt: null }],
      ['a numeric id', { ...PAYLOAD, id: 42 }],
      ['a numeric customer', { ...PAYLOAD, customer: 42 }],
      ['hosts as text', { ...PAYLOAD, hosts: HOST }],
      ['a numeric host', { ...PAYLOAD, hosts: [HOST, 42] }],
      ['expiresAt equal to issuedAt', { ...PAYLOAD, expiresAt: PAYLOAD.issuedAt }],
      ['expiresAt before issuedAt', { ...PAYLOAD, expiresAt: PAYLOAD.issuedAt - 1 }],
      ['negative admin seats', { ...PAYLOAD, adminSeats: -1 }],
      ['100001 admin seats', { ...PAYLOAD, adminSeats: 100_001 }],
      ['negative user seats', { ...PAYLOAD, userSeats: -1 }],
      ['1000001 user seats', { ...PAYLOAD, userSeats: 1_000_001 }],
      ['an empty id', { ...PAYLOAD, id: '' }],
      ['an id of 65 characters', { ...PAYLOAD, id: 'a'.repeat(65) }],
      ['an id with a space', { ...PAYLOAD, id: 'LIC 1' }],
      ['an id with a slash', { ...PAYLOAD, id: 'LIC/1' }],
      ['an id with a letter outside ASCII', { ...PAYLOAD, id: 'LİC-1' }],
      ['an empty customer', { ...PAYLOAD, customer: '' }],
      ['a customer of 201 characters', { ...PAYLOAD, customer: 'C'.repeat(201) }],
      ['an empty host list', { ...PAYLOAD, hosts: [] }],
      ['21 hosts', { ...PAYLOAD, hosts: [HOST, ...Array.from({ length: 20 }, (_, n) => `host-${n}.example.com`)] }],
      ['an uppercase host', { ...PAYLOAD, hosts: ['Platform.example.com'] }],
      ['a host with a port', { ...PAYLOAD, hosts: [`${HOST}:443`] }],
      ['a host given as a URL', { ...PAYLOAD, hosts: [`https://${HOST}`] }],
      ['an empty host', { ...PAYLOAD, hosts: [''] }],
      ['a host with an empty label', { ...PAYLOAD, hosts: ['platform..example.com'] }],
      ['a host that ends in a dot', { ...PAYLOAD, hosts: [`${HOST}.`] }],
      ['a label that starts with a hyphen', { ...PAYLOAD, hosts: ['-platform.example.com'] }],
      ['a label that ends with a hyphen', { ...PAYLOAD, hosts: ['platform-.example.com'] }],
      ['a label of 64 characters', { ...PAYLOAD, hosts: [`${'a'.repeat(64)}.example.com`] }],
      ['a host of 254 characters', { ...PAYLOAD, hosts: [HOST, TOO_LONG_HOST] }],
      ['a wildcard host', { ...PAYLOAD, hosts: ['*.example.com'] }],
      ['a host with an underscore', { ...PAYLOAD, hosts: ['platform_1.example.com'] }],
      ['a negative issuedAt', { ...PAYLOAD, issuedAt: -1 }],
      ['expiresAt in milliseconds', { ...PAYLOAD, expiresAt: 1_823_644_800_000 }],
      ['expiresAt after the year 9999', { ...PAYLOAD, expiresAt: 253_402_300_800 }],
      ['a JSON array', [PAYLOAD]],
      ['JSON null', null],
      ['a JSON number', 1],
      ['a JSON string', 'license'],
    ]
    for (const [name, payload] of cases) {
      expect(codeOf(signLicense(LICENSE_TEST_KEY, payload)), name).toBe('LICENSE_PAYLOAD_INVALID')
    }

    // Signed bytes that are not one JSON object in UTF-8. A lenient decoder would read the first two as a valid
    // license: one replaces the stray byte with U+FFFD, the other drops the byte order mark.
    const tail = Buffer.from(' Ltd","adminSeats":2,"userSeats":25,"issuedAt":1792108800,"expiresAt":1823644800}')
    const head = Buffer.from('{"v":1,"id":"LIC-1","customer":"Example')
    const raw: Array<[string, Buffer]> = [
      ['a byte that is not UTF-8', Buffer.concat([head, Buffer.of(0xff), tail])],
      ['a byte order mark', Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), json(UNBOUND)])],
      ['a __proto__ key', Buffer.from(`{"__proto__":{"userSeats":1000000},${json(UNBOUND).toString('utf8').slice(1)}`)],
      ['an empty payload', Buffer.alloc(0)],
      ['text that is not JSON', Buffer.from('v=1; userSeats=1000000', 'utf8')],
      ['two JSON objects', Buffer.concat([json(UNBOUND), json(UNBOUND)])],
    ]
    for (const [name, bytes] of raw) {
      expect(codeOf(signLicense(LICENSE_TEST_KEY, bytes)), name).toBe('LICENSE_PAYLOAD_INVALID')
    }
  })

  it('refuses a license whose hosts do not include the host of AUTH_URL with LICENSE_HOST_MISMATCH', () => {
    const token = signLicense(LICENSE_TEST_KEY, PAYLOAD)
    for (const host of ['other.example.com', 'example.com', `www.${HOST}`, `${HOST}:443`, 'localhost']) {
      expect(codeOf(token, host), host).toBe('LICENSE_HOST_MISMATCH')
    }
    // Without AUTH_URL there is no host, so a license bound to hosts cannot match.
    expect(codeOf(token, null)).toBe('LICENSE_HOST_MISMATCH')
  })

  it('stops at the first failing check, in the order of the checks', () => {
    const unknown = signLicense(OTHER_LICENSE_TEST_KEY, PAYLOAD)
    const extraField = { ...PAYLOAD, tier: 'enterprise' }
    const cases: Array<[string, string, string, LicenseErrorCode]> = [
      ['a wrong prefix before an unknown kid', withSegment(unknown, 0, 'ldl2'), HOST, 'LICENSE_MALFORMED'],
      [
        'a padded payload before an unknown kid',
        withSegment(unknown, 2, `${segments(unknown)[2]}=`),
        HOST,
        'LICENSE_MALFORMED',
      ],
      ['an unknown kid before a 63-byte signature', withShortSignature(unknown), HOST, 'LICENSE_UNKNOWN_KID'],
      [
        'a 63-byte signature before an invalid payload',
        withShortSignature(signLicense(LICENSE_TEST_KEY, extraField)),
        HOST,
        'LICENSE_MALFORMED',
      ],
      [
        'a forged signature before an invalid payload',
        signLicense(OTHER_LICENSE_TEST_KEY, extraField, LICENSE_TEST_KEY.kid),
        HOST,
        'LICENSE_BAD_SIGNATURE',
      ],
      [
        'an invalid payload before a host mismatch',
        signLicense(LICENSE_TEST_KEY, extraField),
        'other.example.com',
        'LICENSE_PAYLOAD_INVALID',
      ],
    ]
    for (const [name, token, host, code] of cases) {
      expect(codeOf(token, host), name).toBe(code)
    }
  })

  it('answers every one-character change of a valid token with a failure that carries its code alone', () => {
    const token = signLicense(LICENSE_TEST_KEY, PAYLOAD)
    for (let index = 0; index < token.length; index++) {
      for (const replacement of ['A', 'f', '0', '.', '-', '=']) {
        if (token[index] === replacement) continue
        const result = verifyFor(token.slice(0, index) + replacement + token.slice(index + 1))
        expect(result.ok, `a change at ${index}`).toBe(false)
        expect(Object.keys(result).sort(), `a change at ${index}`).toEqual(['code', 'ok'])
        expect(LICENSE_ERROR_CODES, `a change at ${index}`).toContain(result.ok ? undefined : result.code)
      }
    }
  })
})
