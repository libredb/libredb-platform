import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ADMIN_SEAT_CHECK_FAILED } from '@/shared/lib/identity/auth-callbacks'
import { SignInError } from './sign-in-error'

// The operator documentation lists where a refused or failed first sign-in of an admin lands, with the title and text
// the sign-in page shows there, so each of its rows is checked against what this component renders for the code.
const DOC_PATH = path.resolve(__dirname, '../../../../docs/deploy/platform-runtime.md')

interface Landing {
  code: string
  title: string
  text: string
}

/** The lines of the `## License` section of docs/deploy/platform-runtime.md, up to the next heading of level 2. */
function licenseSection(): string[] {
  const lines = readFileSync(DOC_PATH, 'utf8').split('\n')
  const start = lines.indexOf('## License')
  if (start === -1) throw new Error('docs/deploy/platform-runtime.md has no section "## License"')
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

/** The rows of the section's table of sign-in landings, each "The text of `CODE` above" resolved to that text. */
function documentedLandings(): Landing[] {
  const lines = licenseSection()
  const refusalText = (code: string) => {
    const prefix = `- \`${code}\`: `
    const line = lines.find(candidate => candidate.startsWith(prefix))
    if (line === undefined) throw new Error(`the License section gives no text for ${code}`)
    return line.slice(prefix.length)
  }
  return lines
    .filter(line => line.startsWith('| `/login?error='))
    .map(line => {
      const [landing, title, text] = line.split('|').slice(1, 4).map(cell => cell.trim())
      const code = /^`\/login\?error=([A-Za-z_]+)`$/.exec(landing)?.[1]
      if (code === undefined) throw new Error(`not a sign-in landing: ${landing}`)
      const reference = /^The text of `([A-Z_]+)` above$/.exec(text)?.[1]
      return { code, title, text: reference === undefined ? text : refusalText(reference) }
    })
}

describe('SignInError', () => {
  it('shows the title and text that docs/deploy/platform-runtime.md gives each landing of a first admin sign-in', () => {
    const landings = documentedLandings()
    expect(landings.map(landing => landing.code)).toEqual([
      'LICENSE_ADMIN_SEATS',
      'LICENSE_EXPIRED',
      'LICENSE_INVALID',
      ADMIN_SEAT_CHECK_FAILED,
    ])
    for (const { code, title, text } of landings) {
      const { container, unmount } = render(<SignInError code={code} studioUrl="https://studio.example.com" />)
      expect({
        code,
        title: container.querySelector('[data-slot="alert-title"]')?.textContent,
        text: container.querySelector('[data-slot="alert-description"]')?.textContent,
      }).toEqual({ code, title, text })
      unmount()
    }
  })
})
