// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(__dirname, '..', '..')

// Only scripts/vendor-studio-governance.mjs writes the vendored Studio governance files.
const EXEMPT = ['tests/fixtures/governance/']

// Unicode's pictographs, which hold every emoji, the regional indicators of the flags, and the check mark and ballot X
// of Dingbats, written as escapes so that this file holds none. The copyright, registered and trade mark signs are
// pictographs to Unicode and typography here, so they stay allowed.
const EMOJI = /(?![\u00A9\u00AE\u2122])[\p{Extended_Pictographic}\p{Regional_Indicator}\u2713\u2717]/u

/** Whether a file is binary by Git's own test: a NUL byte in its first 8000 bytes. */
function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0)
}

describe('tracked files', () => {
  it('hold no emoji outside tests/fixtures/governance/', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    expect(tracked).toContain('package.json')
    const offenders = tracked
      .filter(file => !EXEMPT.some(folder => file.startsWith(folder)))
      // A tracked file deleted from the working tree holds no text.
      .filter(file => existsSync(path.join(ROOT, file)))
      .filter(file => {
        const content = readFileSync(path.join(ROOT, file))
        return !isBinary(content) && EMOJI.test(content.toString('utf8'))
      })
    expect(offenders).toEqual([])
  })
})
