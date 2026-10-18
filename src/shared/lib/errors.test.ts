import { describe, it, expect } from 'vitest'
import {
  AppError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  LimitExceededError,
  LicenseLimitError,
  UnauthorizedError,
  LICENSE_LIMIT_CODES,
  licenseLimitMessage,
} from './errors'

describe('AppError', () => {
  it('should create with code and statusCode', () => {
    const err = new AppError('not found', 'NOT_FOUND', 404)
    expect(err.message).toBe('not found')
    expect(err.code).toBe('NOT_FOUND')
    expect(err.statusCode).toBe(404)
    expect(err).toBeInstanceOf(Error)
  })

  it('should create NotFoundError with defaults', () => {
    const err = new NotFoundError('User')
    expect(err.message).toBe('User not found')
    expect(err.code).toBe('NOT_FOUND')
    expect(err.statusCode).toBe(404)
  })

  it('should create ForbiddenError', () => {
    const err = new ForbiddenError('connection.create')
    expect(err.message).toBe('Permission denied: connection.create')
    expect(err.code).toBe('FORBIDDEN')
    expect(err.statusCode).toBe(403)
  })

  it('should create ValidationError with field errors', () => {
    const err = new ValidationError({ email: ['Invalid email'] })
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.statusCode).toBe(422)
    expect(err.fieldErrors).toEqual({ email: ['Invalid email'] })
  })

  it('should create LimitExceededError', () => {
    const err = new LimitExceededError('connections', 10)
    expect(err.message).toBe('Limit exceeded: connections (max: 10)')
    expect(err.code).toBe('LIMIT_EXCEEDED')
    expect(err.statusCode).toBe(403)
  })

  it('should create LicenseLimitError with the fixed text of its code', () => {
    const cases = [
      [
        'LICENSE_EXPIRED',
        'The license has expired. Existing access keeps working, and adding users, connections or admins needs a renewed license.',
      ],
      [
        'LICENSE_INVALID',
        'The license could not be verified. Existing access keeps working, and adding users, connections or admins needs a valid license.',
      ],
      [
        'LICENSE_USER_SEATS',
        'Not enough user seats. Free a seat by revoking all grants of a user, or install a license with more user seats.',
      ],
      [
        'LICENSE_ADMIN_SEATS',
        'Not enough admin seats. Free a seat by removing the admin role from an account in Keycloak, or install a license with more admin seats.',
      ],
    ] as const
    for (const [code, message] of cases) {
      const err = new LicenseLimitError(code)
      expect(err, code).toBeInstanceOf(AppError)
      expect(err.code).toBe(code)
      expect(err.message).toBe(message)
      expect(err.statusCode).toBe(403)
      // The pages show the same text before a write is refused, such as on a disabled button.
      expect(licenseLimitMessage(code)).toBe(message)
    }
    expect([...LICENSE_LIMIT_CODES].sort()).toEqual(cases.map(([code]) => code).sort())
  })

  it('should create UnauthorizedError', () => {
    const err = new UnauthorizedError()
    expect(err.message).toBe('Unauthorized')
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.statusCode).toBe(401)
  })
})
