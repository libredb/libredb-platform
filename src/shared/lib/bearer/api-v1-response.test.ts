import { describe, expect, it, vi } from 'vitest'
import { AppError, ConfigError, LicenseLimitError, NotFoundError, ValidationError } from '../errors'
import { KeycloakUnavailableError } from '../keycloak/errors'
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

  it.each([
    [new IdentityProviderUnavailableError(new Error('unable to verify the first certificate')), 'IDENTITY_PROVIDER_UNAVAILABLE'],
    [
      new KeycloakUnavailableError('GET http://keycloak:8080/admin/realms/libredb/users could not be reached', new Error('ECONNREFUSED')),
      'KEYCLOAK_UNAVAILABLE',
    ],
  ])('answers %s with 503, its code and a generic message, and logs it with its cause', async (error, code) => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {})

    const { status, body } = await answer(error)

    expect(status).toBe(503)
    expect(body).toEqual({ error: { code, message: 'The service is temporarily unavailable' } })
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith(expect.any(String), error.cause, { code, status: 503, message: error.message })
    logged.mockRestore()
  })

  it('answers 500 INTERNAL_ERROR for a ConfigError, logged with its message and never answered with it', async () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const error = new ConfigError('a self-hosted install needs exactly one tenant, and the database holds none')

    const { status, body } = await answer(error)

    expect(status).toBe(500)
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
    expect(logged).toHaveBeenCalledWith(expect.any(String), error, { code: 'CONFIG_ERROR', status: 500, message: error.message })
    logged.mockRestore()
  })
})
