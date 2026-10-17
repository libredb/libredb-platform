import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { z } from 'zod'
import { ConfigError, ForbiddenError } from './errors'

export const DEPLOYMENT_MODES = ['cloud', 'self-hosted'] as const

export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number]

/**
 * The DEPLOYMENT_MODE rule, shared with the runtime configuration schema.
 * There is no default, and an error message never repeats the value.
 */
export const deploymentModeSchema = z.enum(DEPLOYMENT_MODES, {
  error: issue => (issue.input === undefined ? 'is required' : 'must be "cloud" or "self-hosted"'),
})

/** Parses DEPLOYMENT_MODE; a missing, empty or unknown value throws ConfigError naming the variable. */
export function parseDeploymentMode(raw: string | undefined): DeploymentMode {
  const result = deploymentModeSchema.safeParse(raw === '' ? undefined : raw)
  if (!result.success) {
    throw new ConfigError(`DEPLOYMENT_MODE ${result.error.issues[0].message}`)
  }
  return result.data
}

export function getDeploymentMode(): DeploymentMode {
  return parseDeploymentMode(process.env.DEPLOYMENT_MODE)
}

export function isSelfHosted(): boolean {
  return getDeploymentMode() === 'self-hosted'
}

/** Refuses an action that exists only in cloud mode, such as registration, tenant administration and team management. */
export function assertCloudOnly(): void {
  if (isSelfHosted()) {
    throw new ForbiddenError('not available in self-hosted mode')
  }
}

/**
 * Answers 404 for a page that exists only in cloud mode, such as registration, billing and tenant administration.
 * The mode is read per request, never at build time, so one build serves both modes.
 */
export async function notFoundInSelfHosted(): Promise<void> {
  await connection()
  if (isSelfHosted()) {
    notFound()
  }
}
