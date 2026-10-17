// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(__dirname, '..', '..')

// Two folders keep text that is not rewritten here: an applied migration never changes, because every database records
// its checksum, and only scripts/vendor-studio-governance.mjs writes the vendored Studio governance files.
const EXEMPT = ['prisma/migrations/', 'tests/fixtures/governance/']

// The en dash U+2013 and the em dash U+2014, written as escapes so that this file holds neither.
const DASHES = /[\u2013\u2014]/

/** Whether a file is binary by Git's own test: a NUL byte in its first 8000 bytes. */
function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0)
}

describe('tracked files', () => {
  it('hold no em dash or en dash outside prisma/migrations/ and tests/fixtures/governance/', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    expect(tracked).toContain('package.json')
    const offenders = tracked
      .filter(file => !EXEMPT.some(folder => file.startsWith(folder)))
      // A tracked file deleted from the working tree holds no text.
      .filter(file => existsSync(path.join(ROOT, file)))
      .filter(file => {
        const content = readFileSync(path.join(ROOT, file))
        return !isBinary(content) && DASHES.test(content.toString('utf8'))
      })
    expect(offenders).toEqual([])
  })
})
