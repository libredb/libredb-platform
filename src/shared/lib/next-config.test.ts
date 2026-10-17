import { describe, it, expect } from 'vitest'
import nextConfig from '../../../next.config'

describe('next.config.ts', () => {
  it('build-time type checking is not disabled', () => {
    expect(nextConfig.typescript?.ignoreBuildErrors).not.toBe(true)
  })

  // Since Next.js 16.3, `next dev` run by a coding agent replaces the managed block of AGENTS.md with Next.js's own
  // text, whose em dashes scripts/ci/no-long-dashes.test.ts refuses, so AGENTS.md keeps the repository's wording.
  it('next dev does not rewrite AGENTS.md', () => {
    expect(nextConfig.agentRules).toBe(false)
  })
})
