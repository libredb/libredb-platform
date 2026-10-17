import type { ZodType } from 'zod'
import { getCurrentUser } from './auth-utils'
import { AppError, ValidationError } from './errors'
import { logger } from './logger'
import type { CurrentUser, Result } from '../types'

export function safeAction<TInput, TOutput>(
  name: string,
  schema: ZodType<TInput>,
  handler: (input: TInput, user: CurrentUser) => Promise<TOutput>,
) {
  return async (input: TInput): Promise<Result<TOutput>> => {
    const start = performance.now()
    let user: CurrentUser

    try {
      user = await getCurrentUser()
    } catch {
      return { success: false, error: 'Unauthorized' }
    }

    logger.debug(`→ ${name}`, {
      userId: user.id,
      tenantId: user.currentTenantId,
    })

    try {
      const parsed = schema.safeParse(input)
      if (!parsed.success) {
        const fieldErrors: Record<string, string[]> = {}
        for (const issue of parsed.error.issues) {
          const path = issue.path.join('.')
          fieldErrors[path] = fieldErrors[path] ?? []
          fieldErrors[path].push(issue.message)
        }
        logger.debug(`← ${name} VALIDATION_ERROR`, { fieldErrors })
        return { success: false, error: 'Validation failed', fieldErrors }
      }

      const result = await handler(parsed.data, user)
      const duration = Math.round(performance.now() - start)

      logger.debug(`← ${name} OK`, { duration, userId: user.id })
      return { success: true, data: result }
    } catch (error) {
      const duration = Math.round(performance.now() - start)

      if (error instanceof ValidationError) {
        logger.debug(`← ${name} VALIDATION_ERROR`, { fieldErrors: error.fieldErrors })
        return { success: false, error: error.message, fieldErrors: error.fieldErrors }
      }

      if (error instanceof AppError) {
        logger.warn(`← ${name} FAIL: ${error.code}`, {
          duration,
          userId: user.id,
          code: error.code,
        })
        return { success: false, error: error.message }
      }

      logger.error(`← ${name} ERROR`, error as Error, {
        duration,
        userId: user.id,
      })
      return { success: false, error: 'Internal server error' }
    }
  }
}
