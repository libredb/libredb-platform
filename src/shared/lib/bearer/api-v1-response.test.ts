import { describe, expect, it, vi } from 'vitest'
import { AppError, LicenseLimitError, NotFoundError, ValidationError } from '../errors'
import { logger } from '../logger'
import { apiV1ErrorResponse } from './api-v1-response'
import {
  AdminRoleRequiredError,
  ApiDisabledError,
  BearerInvalidError,
  IdentityProviderUnavailableError,
} from './errors'

async function answer(error: unknown): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = apiV1ErrorResponse(error)
  return { status: response.status, body: await response.json(), headers: response.headers }
}

describe('apiV1ErrorResponse', () => {
  it('answers 401 BEARER_INVALID with the invalid_token challenge', async () => {
    const { status, body, headers } = await answer(new BearerInvalidError('The bearer token has expired'))

    expect(status).toBe(401)
    expect(body).toEqual({ error: { code: 'BEARER_INVALID', message: 'The bearer token has expired' } })
    expect(headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
  })

  it.each([
    [new AdminRoleRequiredError(), 403, 'ADMIN_ROLE_REQUIRED'],
    [new LicenseLimitError('LICENSE_ADMIN_SEATS'), 403, 'LICENSE_ADMIN_SEATS'],
    [new IdentityProviderUnavailableError(), 503, 'IDENTITY_PROVIDER_UNAVAILABLE'],
    [new ApiDisabledError(), 404, 'API_DISABLED'],
    [new NotFoundError('Connection'), 404, 'NOT_FOUND'],
    [new AppError('Conflict', 'GRANT_CONFLICT', 409), 409, 'GRANT_CONFLICT'],
  ])('answers %s with status %i and its code', async (error, expectedStatus, code) => {
    const { status, body, headers } = await answer(error)

    expect(status).toBe(expectedStatus)
    expect(body).toEqual({ error: { code, message: error.message } })
    expect(headers.get('www-authenticate')).toBeNull()
  })

  it('answers 400 VALIDATION_FAILED with the field errors of a ValidationError', async () => {
    const { status, body } = await answer(new ValidationError({ connectionId: ['Required'] }))

    expect(status).toBe(400)
    expect(body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Validation failed', fieldErrors: { connectionId: ['Required'] } },
    })
  })

  it('answers 500 INTERNAL_ERROR for any other error, logged without its message in the answer', async () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {})

    const { status, body } = await answer(new Error('connection refused at 10.0.0.5'))

    expect(status).toBe(500)
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
  })
})
