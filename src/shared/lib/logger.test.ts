import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createLogger } from './logger'

describe('Logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('should log at info level when LOG_LEVEL=info', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createLogger('info', 'json')

    logger.info('test message', { userId: 'u1' })

    expect(spy).toHaveBeenCalledOnce()
    const output = JSON.parse(spy.mock.calls[0][0] as string)
    expect(output.level).toBe('info')
    expect(output.message).toBe('test message')
    expect(output.userId).toBe('u1')
    expect(output.timestamp).toBeDefined()
  })

  it('should NOT log debug when LOG_LEVEL=info', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const logger = createLogger('info', 'json')

    logger.debug('debug message')

    expect(spy).not.toHaveBeenCalled()
  })

  it('should sanitize sensitive fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createLogger('info', 'json')

    logger.info('test', { password: 'secret123', token: 'abc', userId: 'u1' })

    const output = JSON.parse(spy.mock.calls[0][0] as string)
    expect(output.password).toBe('[REDACTED]')
    expect(output.token).toBe('[REDACTED]')
    expect(output.userId).toBe('u1')
  })

  it('redacts the value of PLATFORM_LICENSE at any depth, in either format and beside an error', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const license = 'ldl1.0123456789abcdef.leaked-payload.leaked-signature'

    createLogger('info', 'json').info('config', { PLATFORM_LICENSE: license, config: { platform_license: license } })
    createLogger('info', 'pretty').info('config', { PLATFORM_LICENSE: license })
    createLogger('info', 'json').error('failed', new Error('failed'), { PLATFORM_LICENSE: license })

    const output = JSON.parse(log.mock.calls[0][0] as string)
    expect(output.PLATFORM_LICENSE).toBe('[REDACTED]')
    expect(output.config.platform_license).toBe('[REDACTED]')
    expect(JSON.parse(error.mock.calls[0][0] as string).PLATFORM_LICENSE).toBe('[REDACTED]')
    expect([...log.mock.calls, ...error.mock.calls].flat().join('\n')).not.toContain('leaked')
  })

  it('should log errors with stack trace', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createLogger('info', 'json')
    const error = new Error('test error')

    logger.error('something failed', error, { path: '/api/test' })

    const output = JSON.parse(spy.mock.calls[0][0] as string)
    expect(output.level).toBe('error')
    expect(output.error.message).toBe('test error')
    expect(output.error.stack).toBeDefined()
    expect(output.path).toBe('/api/test')
  })
})
