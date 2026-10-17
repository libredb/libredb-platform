import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReducedMotion } from './use-reduced-motion'

describe('useReducedMotion', () => {
  let currentMatches = false
  const listeners: Array<() => void> = []

  beforeEach(() => {
    currentMatches = false
    listeners.length = 0
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return currentMatches
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, cb: () => void) => listeners.push(cb),
        removeEventListener: (_: string, cb: () => void) => {
          const i = listeners.indexOf(cb)
          if (i >= 0) listeners.splice(i, 1)
        },
        dispatchEvent: vi.fn(),
      })),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false when prefers-reduced-motion: no-preference', () => {
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)
  })

  it('updates when matchMedia fires a change', () => {
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)
    act(() => {
      currentMatches = true
      listeners.forEach((l) => l())
    })
    expect(result.current).toBe(true)
  })

  it('removes listener on unmount', () => {
    const { unmount } = renderHook(() => useReducedMotion())
    expect(listeners.length).toBeGreaterThan(0)
    unmount()
    expect(listeners.length).toBe(0)
  })
})
