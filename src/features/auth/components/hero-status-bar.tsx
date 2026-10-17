'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useReducedMotion } from '../hooks/use-reduced-motion'

function formatUtc(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `UTC ${hh}:${mm}:${ss}`
}

const subscribeToNothing = () => () => {}

/**
 * False on the server and during hydration, true once the component is mounted on the client.
 * The clock renders only after mount: a server time that differs from the client's by a second would be a hydration
 * mismatch, and React would render the page again on the client, dropping what the user typed into the login form.
 */
function useMounted(): boolean {
  return useSyncExternalStore(subscribeToNothing, () => true, () => false)
}

export function HeroStatusBar() {
  const reduced = useReducedMotion()
  const mounted = useMounted()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    // When reduced motion is on, still show the clock but don't tick every second.
    const intervalMs = reduced ? 60_000 : 1_000
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [reduced])

  return (
    <div className="flex items-center justify-between border-b border-border/50 pb-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
      <div className="flex items-center gap-2.5">
        <span className="text-chart-4" aria-hidden="true">●</span>
        <span>PLATFORM · LIVE</span>
      </div>
      <div className="flex items-center gap-4 font-normal normal-case tracking-normal">
        <span>region: eu-central</span>
        <span>uptime: 99.99%</span>
        <span className="tabular-nums">{mounted ? formatUtc(now) : 'UTC --:--:--'}</span>
      </div>
    </div>
  )
}
