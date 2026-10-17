import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

vi.mock('./auth-utils', () => ({
  getCurrentUser: vi.fn().mockResolvedValue({
    id: 'user-1',
    email: 'test@test.com',
    name: 'Test',
    currentTenantId: 'tenant-1',
    membershipId: 'member-1',
    roles: ['TENANT_ADMIN'],
    permissions: ['connection.create'],
    accessibleTenants: [],
  }),
}))

vi.mock('./logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { safeAction } from './safe-action'

describe('safeAction', () => {
  it('should validate input, execute handler, and return success', async () => {
    const schema = z.object({ name: z.string().min(1) })
    const handler = vi.fn().mockResolvedValue({ id: '1', name: 'Test' })

    const action = safeAction('test-action', schema, handler)
    const result = await action({ name: 'Test' })

    expect(result).toEqual({ success: true, data: { id: '1', name: 'Test' } })
    expect(handler).toHaveBeenCalledWith({ name: 'Test' }, expect.objectContaining({ id: 'user-1' }))
  })

  it('should return validation error for invalid input', async () => {
    const schema = z.object({ name: z.string().min(1) })
    const handler = vi.fn()

    const action = safeAction('test-action', schema, handler)
    const result = await action({ name: '' })

    expect(result.success).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('should catch AppError and return failure', async () => {
    const { AppError } = await import('./errors')
    const schema = z.object({ name: z.string() })
    const handler = vi.fn().mockRejectedValue(new AppError('Not found', 'NOT_FOUND', 404))

    const action = safeAction('test-action', schema, handler)
    const result = await action({ name: 'test' })

    expect(result).toEqual({ success: false, error: 'Not found' })
  })

  it('returns the field errors of a ValidationError the handler throws', async () => {
    const { ValidationError } = await import('./errors')
    const schema = z.object({ name: z.string() })
    const handler = vi.fn().mockRejectedValue(new ValidationError({ name: ['is taken'] }))

    const action = safeAction('test-action', schema, handler)
    const result = await action({ name: 'test' })

    expect(result).toEqual({ success: false, error: 'Validation failed', fieldErrors: { name: ['is taken'] } })
  })
})
