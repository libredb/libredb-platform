import { describe, it, expect } from 'vitest'
import nextConfig from '../../../next.config'

describe('next.config.ts', () => {
  it('build-time type checking is not disabled', () => {
    expect(nextConfig.typescript?.ignoreBuildErrors).not.toBe(true)
  })
})
