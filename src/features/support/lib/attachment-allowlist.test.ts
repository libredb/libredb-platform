import { describe, it, expect } from 'vitest'
import {
  MAX_FILE_BYTES, MAX_TICKET_BYTES, MAX_FILES_PER_MESSAGE,
  isAllowedMime, isAllowedExtension, isDeniedExtension,
} from './attachment-allowlist'

describe('attachment allowlist', () => {
  it('has 25 MB per-file limit', () => {
    expect(MAX_FILE_BYTES).toBe(25 * 1024 * 1024)
  })
  it('has 100 MB per-ticket limit', () => {
    expect(MAX_TICKET_BYTES).toBe(100 * 1024 * 1024)
  })
  it('caps files per message at 10', () => {
    expect(MAX_FILES_PER_MESSAGE).toBe(10)
  })

  it('allows image, pdf, text', () => {
    expect(isAllowedMime('image/png')).toBe(true)
    expect(isAllowedMime('image/jpeg')).toBe(true)
    expect(isAllowedMime('application/pdf')).toBe(true)
    expect(isAllowedMime('text/plain')).toBe(true)
    expect(isAllowedMime('application/json')).toBe(true)
  })
  it('rejects dangerous MIME types', () => {
    expect(isAllowedMime('text/html')).toBe(false)
    expect(isAllowedMime('image/svg+xml')).toBe(false)
    expect(isAllowedMime('application/x-executable')).toBe(false)
  })

  it('allows whitelisted extensions', () => {
    expect(isAllowedExtension('error.png')).toBe(true)
    expect(isAllowedExtension('logs.log')).toBe(true)
    expect(isAllowedExtension('query.sql')).toBe(true)
  })
  it('rejects denylisted extensions regardless of MIME', () => {
    expect(isDeniedExtension('evil.exe')).toBe(true)
    expect(isDeniedExtension('payload.svg')).toBe(true)
    expect(isDeniedExtension('trojan.HTML')).toBe(true)
    expect(isDeniedExtension('run.sh')).toBe(true)
  })
})
