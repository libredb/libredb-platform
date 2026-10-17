import type { KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canonicalDefinition } from './jcs'
import {
  bindingAad,
  envelopeKid,
  kidOf,
  PLAINTEXT_KEYS,
  PLAINTEXT_MAX_BYTES,
  SealError,
  sealSecret,
  type CredentialSet,
  type SealBinding,
} from './lsb1'

// Lets one test make X25519 return the all-zero result that OpenSSL refuses to return itself. Vitest resolves a
// named import of a Node built-in through its default export, so the mock replaces the function in both.
const dh = vi.hoisted(() => ({ allZero: false }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const diffieHellman = (options: { privateKey: KeyObject; publicKey: KeyObject }) =>
    dh.allZero ? Buffer.alloc(32) : actual.diffieHellman(options)
  return { ...actual, default: { ...actual, diffieHellman }, diffieHellman }
})

// Studio's lsb1 test vectors and contract manifest, vendored by scripts/vendor-studio-governance.mjs.
// Every key in the vectors is a published test key that protects nothing.
const GOVERNANCE_DIR = path.resolve(__dirname, '../../../../tests/fixtures/governance')
const VECTORS_FILE = path.join(GOVERNANCE_DIR, 'lsb1-vectors.json')
const MANIFEST_FILE = path.join(GOVERNANCE_DIR, 'contract-v1.json')

interface Vector {
  id: string
  recipientPublicKey: string
  kid: string
  binding: SealBinding
  definitionJcs: string
  aadHex: string
  ephemeralPrivateKey: string
  plaintext: Record<string, unknown>
  envelope: string
  opening: { envelope: string; binding: SealBinding }
  expected: string
}

const vectors: Vector[] = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')).vectors
const positive = vectors.filter((vector) => vector.expected === 'ok')

function vector(id: string): Vector {
  const found = vectors.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`lsb1-vectors.json has no vector ${id}`)
  return found
}

function bytes(base64url: string): Buffer {
  return Buffer.from(base64url, 'base64url')
}

// Seals `plaintext` (the vector's own by default) for the vector's binding to its recipient with its fixed ephemeral key.
function sealVector(source: Vector, plaintext: unknown = source.plaintext): string {
  return sealSecret(
    { ...source.binding, plaintext: plaintext as CredentialSet },
    bytes(source.recipientPublicKey),
    { ephemeralPrivateKey: bytes(source.ephemeralPrivateKey) },
  )
}

// What `run` threw; fails when it returns.
function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

// The code of the SealError that `run` throws.
function sealErrorCode(run: () => unknown): string {
  const error = thrownBy(run)
  if (!(error instanceof SealError)) throw error
  return error.code
}

// The four dot-separated fields of an envelope.
function fields(envelope: string): string[] {
  return envelope.split('.')
}

describe('sealSecret', () => {
  it("reproduces every positive envelope of the vendored lsb1-vectors.json byte for byte with the vector's fixed ephemeral key", () => {
    // The positive cases GOVERNANCE.md lists.
    expect(positive.map((source) => source.id)).toEqual(
      expect.arrayContaining([
        'canary',
        'unicode',
        'json-escapes',
        'nested-ssl-pem',
        'numbers',
        'key-order',
        'write-level',
        'every-plaintext-key',
      ]),
    )
    for (const source of positive) {
      expect(sealVector(source), source.id).toBe(source.envelope)
    }
  })

  it('reproduces the sealed envelope of every negative vector whose plaintext is a credential set', () => {
    // A negative vector alters its sealed envelope or binding afterwards, so the sealed envelope is a good one, here
    // also sealed to a second recipient (unknown-kid). Only the two invalid plaintexts are refused instead.
    const negative = vectors.filter((source) => source.expected !== 'ok' && source.expected !== 'PLAINTEXT_INVALID')
    expect(negative.map((source) => source.id)).toContain('unknown-kid')
    for (const source of negative) {
      expect(sealVector(source), source.id).toBe(source.envelope)
    }
  })

  it("bindingAad equals each vector's AAD, including key order, unicode and nested ssl definitions", () => {
    for (const source of vectors) {
      expect(canonicalDefinition(source.binding.definition), source.id).toBe(source.definitionJcs)
      expect(bindingAad(source.binding, source.kid).toString('hex'), source.id).toBe(source.aadHex)
    }
    // A positive vector opens for its opening binding, so that binding gives the same AAD: key-order lists the keys
    // of its definition and of its nested ssl object in another order there.
    for (const source of positive) {
      expect(bindingAad(source.opening.binding, source.kid).toString('hex'), source.id).toBe(source.aadHex)
    }
    const keyOrder = vector('key-order')
    expect(Object.keys(keyOrder.opening.binding.definition)).not.toEqual(Object.keys(keyOrder.binding.definition))
    expect(vector('unicode').definitionJcs).toContain('\ud842\udfb7')
    expect(vector('nested-ssl-pem').definitionJcs).toContain('"ssl":{"caCert":"-----BEGIN CERTIFICATE-----\\n')
  })

  it("kidOf equals each vector's kid", () => {
    for (const source of vectors) {
      expect(kidOf(bytes(source.recipientPublicKey)), source.id).toBe(source.kid)
    }
    expect(new Set(vectors.map((source) => source.kid)).size).toBe(2)
    expect(() => kidOf(Buffer.alloc(31))).toThrow(RangeError)
    expect(() => kidOf(Buffer.alloc(33))).toThrow(RangeError)
  })

  it('refuses an unknown plaintext key and an oversized plaintext with PLAINTEXT_INVALID', () => {
    const app = vector('auth-failed-level')
    expect(sealErrorCode(() => sealVector(vector('plaintext-unknown-key')))).toBe('PLAINTEXT_INVALID')
    expect(sealErrorCode(() => sealVector(app, { user: 'app_reader', ssl: 'verify-full' }))).toBe('PLAINTEXT_INVALID')

    // The limit is 65536 bytes of the UTF-8 JSON text: {"password":""} takes 15 of them.
    const room = PLAINTEXT_MAX_BYTES - Buffer.byteLength('{"password":""}')
    expect(fields(sealVector(app, { password: 'x'.repeat(room) }))).toHaveLength(4)
    expect(sealErrorCode(() => sealVector(app, { password: 'x'.repeat(room + 1) }))).toBe('PLAINTEXT_INVALID')
    // U+015F takes two UTF-8 bytes, so about half as many characters already exceed the room.
    expect(sealErrorCode(() => sealVector(app, { password: '\u015f'.repeat(Math.floor(room / 2) + 1) }))).toBe(
      'PLAINTEXT_INVALID',
    )
  })

  it('refuses a value that is not a string and a plaintext that is not a JSON object with PLAINTEXT_INVALID', () => {
    const app = vector('auth-failed-level')
    expect(sealErrorCode(() => sealVector(vector('plaintext-non-string-value')))).toBe('PLAINTEXT_INVALID')
    for (const plaintext of [{ user: 'app_reader', password: undefined }, { user: null }, [], null, 'secret', new Map()]) {
      expect(sealErrorCode(() => sealVector(app, plaintext)), JSON.stringify(plaintext)).toBe('PLAINTEXT_INVALID')
    }
    // No message carries the plaintext.
    const error = thrownBy(() => sealVector(app, { user: 'app_reader', password: 12345678 }))
    expect((error as Error).message).not.toContain('app_reader')
    expect((error as Error).message).not.toContain('12345678')
  })

  it('an all-zero or failing Diffie-Hellman maps to LOW_ORDER_POINT', () => {
    const app = vector('auth-failed-level')
    const sealTo = (publicKey: Buffer) => () =>
      sealSecret({ ...app.binding, plaintext: { user: 'app_reader' } }, publicKey)
    // OpenSSL refuses the points of order 2 and 8 that the low-order-point vectors use as enc.
    expect(sealErrorCode(sealTo(Buffer.alloc(32)))).toBe('LOW_ORDER_POINT')
    expect(sealErrorCode(sealTo(bytes(fields(vector('low-order-point-order-eight').opening.envelope)[2])))).toBe(
      'LOW_ORDER_POINT',
    )
    // A runtime that returns the all-zero result instead of refusing it gets the same code.
    dh.allZero = true
    try {
      expect(sealErrorCode(sealTo(bytes(app.recipientPublicKey)))).toBe('LOW_ORDER_POINT')
    } finally {
      dh.allZero = false
    }
  })

  it('uses the plaintext keys, size limit and envelope codes of the vendored contract-v1.json', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
    expect([...PLAINTEXT_KEYS]).toEqual(manifest.plaintext.keys)
    expect(PLAINTEXT_MAX_BYTES).toBe(manifest.plaintext.maxBytes)
    expect(manifest.codes.envelope).toEqual(expect.arrayContaining(['FORMAT', 'LOW_ORDER_POINT', 'PLAINTEXT_INVALID']))
  })

  it('draws a fresh ephemeral key for every seal', () => {
    const app = vector('auth-failed-level')
    const seal = () => sealSecret({ ...app.binding, plaintext: { user: 'app_reader' } }, bytes(app.recipientPublicKey))
    const [first, second] = [seal(), seal()]
    expect(first).toMatch(/^lsb1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22,})$/)
    expect(fields(first)[1]).toBe(app.kid)
    expect(fields(first)[2]).not.toBe(fields(second)[2])
    expect(fields(first)[3]).not.toBe(fields(second)[3])
  })
})

describe('envelopeKid', () => {
  it('reads the kid of an lsb1 envelope and refuses any other text with FORMAT', () => {
    for (const source of vectors) {
      expect(envelopeKid(source.envelope), source.id).toBe(source.kid)
    }
    const [, kid, enc, sealed] = fields(vector('canary').envelope)
    for (const text of [
      '',
      `lsb2.${kid}.${enc}.${sealed}`,
      `lsb1.${kid.toUpperCase()}.${enc}.${sealed}`,
      `lsb1.${kid}.${enc}`,
      `lsb1.${kid}.${enc}.${sealed}.extra`,
      vector('format-padded-base64').opening.envelope,
    ]) {
      expect(sealErrorCode(() => envelopeKid(text)), text).toBe('FORMAT')
    }
  })
})
