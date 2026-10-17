// Development only: prints the development seal key pair, the X25519 key pair that Platform seals connection
// credentials to on a developer's machine and in the self-hosted e2e run.
//
//   node scripts/dev/gen-seal-keypair.mjs
//
// It prints BRIDGE_SEAL_PUBLIC_KEY for Platform, the value that .env.example and e2e/self-hosted/platform.env carry,
// and the matching keyring JSON for a development Studio, which reads it from the file GOVERNANCE_PRIVATE_KEYS_FILE
// names. The private key is the SHA-256 of a published label, so every run prints the same pair and anyone can derive
// it: the pair protects nothing, and no real credential may be sealed to it. An install gets its own key pair from the
// installer.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'libredb development seal key, development only'

// The DER that wraps a raw X25519 private key as PKCS #8, and the length of the DER that precedes the raw public key
// in a SubjectPublicKeyInfo (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX_BYTES = 12

/**
 * The development seal key pair: the raw private and public keys as unpadded base64url, and the kid of the public key,
 * the lowercase hex of the first 8 bytes of its SHA-256.
 * @returns {{ privateKey: string, publicKey: string, kid: string }}
 */
export function developmentSealKeyPair() {
  const privateKey = createHash('sha256').update(LABEL, 'utf8').digest()
  const keyObject = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, privateKey]), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(keyObject).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX_BYTES)
  return {
    privateKey: privateKey.toString('base64url'),
    publicKey: publicKey.toString('base64url'),
    kid: createHash('sha256').update(publicKey).digest().subarray(0, 8).toString('hex'),
  }
}

function main() {
  if (process.argv.length > 2) {
    console.error('Usage: node scripts/dev/gen-seal-keypair.mjs (it takes no argument)')
    process.exit(2)
  }
  const { privateKey, publicKey, kid } = developmentSealKeyPair()
  process.stdout.write(
    [
      `# The development seal key pair, kid ${kid}. Its private key is the SHA-256 of the label "${LABEL}",`,
      '# so anyone can derive it: never seal a real credential to it.',
      '# For Platform, the variable that .env.example and e2e/self-hosted/platform.env carry:',
      `BRIDGE_SEAL_PUBLIC_KEY=${publicKey}`,
      '# For a development Studio, the keyring file that GOVERNANCE_PRIVATE_KEYS_FILE names, readable only by its user:',
      JSON.stringify({ version: 1, keys: [privateKey] }),
      '',
    ].join('\n'),
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
