'use client'

import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(notify: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', notify)
  return () => mq.removeEventListener('change', notify)
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(QUERY).matches
}

function getServerSnapshot(): boolean {
  return false
}

/**
 * Subscribes to `prefers-reduced-motion: reduce`. Returns `true` when the user
 * requests reduced motion. SSR-safe via useSyncExternalStore: server renders
 * `false`, client hydrates and updates to the real value without cascading.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
