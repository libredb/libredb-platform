import { afterEach, describe, it, expect, vi } from 'vitest'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import {
  assertCloudOnly,
  getDeploymentMode,
  isSelfHosted,
  notFoundInSelfHosted,
  parseDeploymentMode,
} from './deployment'
import { ConfigError, ForbiddenError } from './errors'

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

vi.mock('next/server', () => ({
  connection: vi.fn(async () => {}),
}))

function configError(run: () => unknown): ConfigError {
  try {
    run()
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('expected a ConfigError')
}

describe('parseDeploymentMode', () => {
  it('parses cloud and self-hosted', () => {
    expect(parseDeploymentMode('cloud')).toBe('cloud')
    expect(parseDeploymentMode('self-hosted')).toBe('self-hosted')
  })

  it('throws ConfigError naming DEPLOYMENT_MODE when it is missing or invalid', () => {
    for (const raw of [undefined, '', 'bogus-mode', 'Cloud', 'self_hosted', ' cloud']) {
      const error = configError(() => parseDeploymentMode(raw))

      expect(error.message).toMatch(/DEPLOYMENT_MODE/)
      expect(error.message).not.toContain('bogus-mode')
    }
  })
})

describe('getDeploymentMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads DEPLOYMENT_MODE from the environment', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
    expect(getDeploymentMode()).toBe('self-hosted')
    expect(isSelfHosted()).toBe(true)

    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    expect(getDeploymentMode()).toBe('cloud')
    expect(isSelfHosted()).toBe(false)
  })

  it('has no default when DEPLOYMENT_MODE is unset', () => {
    vi.stubEnv('DEPLOYMENT_MODE', undefined)

    expect(() => getDeploymentMode()).toThrow(ConfigError)
    expect(() => isSelfHosted()).toThrow(/DEPLOYMENT_MODE/)
  })
})

describe('assertCloudOnly', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('assertCloudOnly throws ForbiddenError in self-hosted mode and passes in cloud mode', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
    expect(() => assertCloudOnly()).toThrow(ForbiddenError)
    expect(() => assertCloudOnly()).toThrow('Permission denied: not available in self-hosted mode')

    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    expect(() => assertCloudOnly()).not.toThrow()
  })
})

describe('notFoundInSelfHosted', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.mocked(notFound).mockClear()
  })

  it('notFoundInSelfHosted calls notFound in self-hosted mode and returns in cloud mode', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
    await expect(notFoundInSelfHosted()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalledTimes(1)

    vi.mocked(notFound).mockClear()
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    await expect(notFoundInSelfHosted()).resolves.toBeUndefined()
    expect(notFound).not.toHaveBeenCalled()
  })

  it('reads the mode at request time, after connection()', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    await notFoundInSelfHosted()
    expect(connection).toHaveBeenCalled()
  })

  it('throws ConfigError when DEPLOYMENT_MODE is unset', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', undefined)
    await expect(notFoundInSelfHosted()).rejects.toThrow(ConfigError)
    expect(notFound).not.toHaveBeenCalled()
  })
})
