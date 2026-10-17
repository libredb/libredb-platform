import { execFileSync, spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { loadSealKey } from '@/shared/lib/sealing/seal-key'

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'dev', 'gen-seal-keypair.mjs')

// The DER around a raw X25519 key in PKCS #8 and in SubjectPublicKeyInfo (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
// The X25519 base point, u = 9 (RFC 7748 section 4.1).
const BASE_POINT = Buffer.concat([Buffer.of(9), Buffer.alloc(31)])

interface Printed {
  kid: string
  publicKey: string
  keyring: { version: number; keys: string[] }
}

function runScript(): string {
  return execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
}

// The output: comment lines, the line for Platform's environment and the keyring JSON for Studio.
function parseOutput(output: string): Printed {
  const lines = output.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
  expect(lines).toHaveLength(2)
  const variable = /^BRIDGE_SEAL_PUBLIC_KEY=(.*)$/.exec(lines[0])
  const kid = /\bkid ([0-9a-f]{16})\b/.exec(output)
  if (variable === null || kid === null) throw new Error(`unexpected output:\n${output}`)
  return { kid: kid[1], publicKey: variable[1], keyring: JSON.parse(lines[1]) }
}

// The X25519 public key of a raw private key: the Diffie-Hellman result of the key with the base point.
function publicKeyOf(rawPrivateKey: Buffer): Buffer {
  return diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, rawPrivateKey]), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, BASE_POINT]), format: 'der', type: 'spki' }),
  })
}

function envFile(file: string): Record<string, string | undefined> {
  return parseEnv(readFileSync(path.join(ROOT, file), 'utf8'))
}

describe('gen-seal-keypair.mjs', () => {
  it('prints a public key for Platform and a keyring for Studio that holds its private key', () => {
    const { kid, publicKey, keyring } = parseOutput(runScript())

    // The keyring file of Studio's GOVERNANCE.md: version 1 and one unpadded base64url raw 32-byte private key.
    expect(Object.keys(keyring).sort()).toEqual(['keys', 'version'])
    expect(keyring.version).toBe(1)
    expect(keyring.keys).toHaveLength(1)
    const privateKey = Buffer.from(keyring.keys[0], 'base64url')
    expect(privateKey).toHaveLength(32)
    expect(privateKey.toString('base64url')).toBe(keyring.keys[0])

    expect(publicKeyOf(privateKey).toString('base64url')).toBe(publicKey)
    // Platform starts with the key, and the printed kid is the one its envelopes name.
    expect(loadSealKey(publicKey).kid).toBe(kid)
  })

  it('prints the same key pair on every run', () => {
    expect(runScript()).toBe(runScript())
  })

  it('.env.example and e2e/self-hosted/platform.env carry the development public key it prints', () => {
    const { publicKey } = parseOutput(runScript())
    expect(envFile('.env.example').BRIDGE_SEAL_PUBLIC_KEY).toBe(publicKey)
    expect(envFile('e2e/self-hosted/platform.env').BRIDGE_SEAL_PUBLIC_KEY).toBe(publicKey)
  })

  it('refuses an argument, so no option is silently ignored', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--new'], { cwd: ROOT, encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: node scripts/dev/gen-seal-keypair.mjs')
  })
})
