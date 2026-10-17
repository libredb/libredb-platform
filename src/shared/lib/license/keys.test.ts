import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LICENSE_TEST_KEY, OTHER_LICENSE_TEST_KEY, type TestLicenseKey } from '../../../../tests/license/test-keys'
import { LICENSE_KEYS } from './keys'
import { licenseKeyring, type LicenseKey } from './token'

// The kid rule of the format, computed here on its own: the lowercase hex of the first 8 bytes of the SHA-256 of the
// raw 32-byte public key.
function kidOf(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest().subarray(0, 8).toString('hex')
}

// A key list entry for raw key bytes, with the kid derived from them.
function entryFor(publicKey: Buffer): LicenseKey {
  return { kid: kidOf(publicKey), publicKey: publicKey.toString('base64url') }
}

function entryOf(key: TestLicenseKey): LicenseKey {
  return { kid: key.kid, publicKey: key.publicKey }
}

// The y coordinate of each edwards25519 point of order 1, 2, 4 or 8, in the 255 low bits of its little-endian
// encoding: 0 and 1, the two y of the points of order 8, p - 1, and the non-canonical p and p + 1 that decoders reduce
// to 0 and 1, as libsodium's small-order check lists them. Each stands for two encodings, with the sign bit of x clear
// and set.
const SMALL_ORDER_Y = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
]

const SMALL_ORDER_ENCODINGS = SMALL_ORDER_Y.flatMap((hex) => {
  const clear = Buffer.from(hex, 'hex')
  const set = Buffer.from(clear)
  set[31] |= 0x80
  return [clear, set]
})

describe('LICENSE_KEYS', () => {
  it('derives every kid from its key and holds no point of small order', () => {
    for (const key of LICENSE_KEYS) {
      const raw = Buffer.from(key.publicKey, 'base64url')
      expect(raw.toString('base64url'), `license key ${key.kid}`).toBe(key.publicKey)
      expect(kidOf(raw), `license key ${key.kid}`).toBe(key.kid)
      raw[31] &= 0x7f
      expect(SMALL_ORDER_Y, `license key ${key.kid}`).not.toContain(raw.toString('hex'))
    }
    expect(licenseKeyring(LICENSE_KEYS).size).toBe(LICENSE_KEYS.length)
  })

  it('holds none of the test keys', () => {
    for (const key of [LICENSE_TEST_KEY, OTHER_LICENSE_TEST_KEY]) {
      expect(LICENSE_KEYS.map((entry) => entry.kid)).not.toContain(key.kid)
      expect(LICENSE_KEYS.map((entry) => entry.publicKey)).not.toContain(key.publicKey)
    }
  })
})

describe('licenseKeyring', () => {
  it('loads each key of the list under its kid', () => {
    const keyring = licenseKeyring([entryOf(LICENSE_TEST_KEY), entryOf(OTHER_LICENSE_TEST_KEY)])
    expect([...keyring.keys()]).toEqual([LICENSE_TEST_KEY.kid, OTHER_LICENSE_TEST_KEY.kid])
    for (const key of keyring.values()) {
      expect(key.type).toBe('public')
      expect(key.asymmetricKeyType).toBe('ed25519')
    }
    expect(licenseKeyring([]).size).toBe(0)
  })

  it('refuses a kid that does not match its key', () => {
    const swapped = { kid: OTHER_LICENSE_TEST_KEY.kid, publicKey: LICENSE_TEST_KEY.publicKey }
    expect(() => licenseKeyring([entryOf(OTHER_LICENSE_TEST_KEY), swapped])).toThrow(
      'License key 1 has a kid that is not derived from its public key',
    )
    const lastDigit = LICENSE_TEST_KEY.kid.endsWith('0') ? '1' : '0'
    const nearMiss = { ...entryOf(LICENSE_TEST_KEY), kid: LICENSE_TEST_KEY.kid.slice(0, -1) + lastDigit }
    expect(() => licenseKeyring([nearMiss])).toThrow('License key 0 has a kid that is not derived from its public key')
  })

  it('refuses a point of small order, whatever the sign bit', () => {
    expect(SMALL_ORDER_ENCODINGS).toHaveLength(14)
    for (const encoding of SMALL_ORDER_ENCODINGS) {
      expect(() => licenseKeyring([entryFor(encoding)]), encoding.toString('hex')).toThrow(
        'License key 0 is a point of small order',
      )
    }
  })

  it('refuses a kid that is not 16 lowercase hex digits', () => {
    const entry = entryOf(LICENSE_TEST_KEY)
    expect(entry.kid).toMatch(/[a-f]/)
    for (const kid of [entry.kid.toUpperCase(), entry.kid.slice(1), `${entry.kid}0`, '']) {
      expect(() => licenseKeyring([{ ...entry, kid }]), JSON.stringify(kid)).toThrow(
        'License key 0 has a kid that is not 16 lowercase hex digits',
      )
    }
  })

  it('refuses a key that is not the unpadded base64url of 32 bytes', () => {
    const raw = Buffer.from(LICENSE_TEST_KEY.publicKey, 'base64url')
    const cases: Array<[string, string]> = [
      ['31 bytes', raw.subarray(0, 31).toString('base64url')],
      ['33 bytes', Buffer.concat([raw, Buffer.of(0)]).toString('base64url')],
      ['padding', `${LICENSE_TEST_KEY.publicKey}=`],
      // 0xfb repeated is `-_v7` in base64url and `+/v7` in standard base64, which Node's decoder also reads.
      ['standard base64', Buffer.alloc(32, 0xfb).toString('base64').replace(/=+$/, '')],
      ['hex', raw.toString('hex')],
    ]
    for (const [name, publicKey] of cases) {
      expect(() => licenseKeyring([{ kid: LICENSE_TEST_KEY.kid, publicKey }]), name).toThrow(
        'License key 0 is not the unpadded base64url of a raw 32-byte Ed25519 public key',
      )
    }
  })

  it('refuses a key listed twice', () => {
    expect(() => licenseKeyring([entryOf(LICENSE_TEST_KEY), entryOf(LICENSE_TEST_KEY)])).toThrow(
      'License key 1 repeats the kid of an earlier key',
    )
  })
})
