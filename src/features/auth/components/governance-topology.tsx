'use client'

import { Shield } from 'lucide-react'
import {
  demoRoles,
  demoConnections,
  supportedEngines,
  type ConnectionStatus,
  type ConnectionEngine,
} from '../lib/hero-demo-data'

/**
 * Governance topology visualization.
 *
 * Models a SINGLE tenant's internal structure:
 *   the tenant's roles (Admin / Editor / Viewer)
 *     → the governance layer (RBAC + Audit + Plan Gates)
 *       → the tenant's OWN connections (prod-pg, staging, etc.)
 *
 * It must never imply cross-tenant data mixing. A visitor is a tenant
 * customer: they should see "my team / my governance / my databases",
 * not other organizations' names.
 *
 * Marked `aria-hidden` since it's decorative: the semantic governance
 * message is carried by HeroTitle's h1.
 */

function colorForEngine(engine: ConnectionEngine): string {
  const found = supportedEngines.find((e) => e.engine === engine)
  return found?.color ?? 'var(--muted)'
}

function statusClasses(status: ConnectionStatus): { label: string; text: string } {
  if (status === 'slow') return { label: '● slow', text: 'text-chart-5' }
  if (status === 'warning') return { label: '● warn', text: 'text-chart-5' }
  return { label: '● ok', text: 'text-chart-4' }
}

export function GovernanceTopology() {
  return (
    <div className="relative grid grid-cols-[1fr_1.5fr_1fr] gap-4" aria-hidden="true">
      {/* Left: Your roles (within the tenant) */}
      <div className="flex flex-col gap-2">
        <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground/70">
          Roles · {demoRoles.length}
        </div>
        {demoRoles.map((r) => (
          <div
            key={r.key}
            className="flex items-center gap-2 rounded-md border border-border/50 bg-card px-3 py-2 text-xs"
          >
            <span className="h-2 w-2 rounded-full bg-chart-4" />
            <span className="flex-1 text-foreground">{r.name}</span>
            <span className="text-[10px] text-muted-foreground">{r.access}</span>
          </div>
        ))}
      </div>

      {/* Middle: Gateway */}
      <div className="relative flex flex-col items-center justify-center rounded-xl border border-border/60 bg-card/70 p-4">
        <div className="mb-3 text-[9px] font-bold uppercase tracking-[0.15em] text-chart-4">
          Governance Layer
        </div>
        <div
          className="relative mb-3 flex h-20 w-20 items-center justify-center rounded-full border-2 border-chart-4"
          style={{
            background:
              'radial-gradient(circle, color-mix(in oklab, var(--chart-4) 18%, transparent), transparent 70%)',
          }}
        >
          <Shield className="h-8 w-8 text-chart-4" strokeWidth={1.5} />
          <span className="absolute -inset-1.5 rounded-full border border-dashed border-chart-4/30" />
        </div>
        <div className="text-center text-[11px] leading-relaxed text-muted-foreground">
          <div className="mb-1 font-semibold text-foreground">RBAC · Audit · Plan Gates</div>
          <div>
            Every query checked, logged,
            <br />
            metered before execution.
          </div>
        </div>
      </div>

      {/* Right: Your connections */}
      <div className="flex flex-col gap-2">
        <div className="text-right text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground/70">
          Connections · {demoConnections.length}
        </div>
        {demoConnections.map((c) => {
          const s = statusClasses(c.status)
          return (
            <div
              key={c.name}
              className="flex items-center gap-2 rounded-md border border-border/50 bg-card px-3 py-2 text-xs"
            >
              <div
                className="flex h-4 w-4 items-center justify-center rounded-sm text-[9px] font-bold text-white"
                style={{ backgroundColor: colorForEngine(c.engine) }}
              >
                {supportedEngines.find((e) => e.engine === c.engine)?.chip ?? '??'}
              </div>
              <span className="flex-1 text-foreground">{c.name}</span>
              <span className={`text-[9px] ${s.text}`}>{s.label}</span>
            </div>
          )
        })}
      </div>

      {/*
        Flow lines overlay.
        SVG has preserveAspectRatio="none" so viewBox coordinates stretch linearly
        to fill the grid. Grid columns are 1fr 1.5fr 1fr (total 3.5fr):
          • left column right edge ≈ (1/3.5) × 600 ≈ 171
          • center column center = 300
          • right column left edge ≈ (2.5/3.5) × 600 ≈ 429
        Path endpoints use these x-coords so lines align with column boundaries at any width.
      */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 600 240"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="flow-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.5" />
            <stop offset="0.5" stopColor="var(--chart-4)" stopOpacity="0.8" />
            <stop offset="1" stopColor="var(--primary)" stopOpacity="0.5" />
          </linearGradient>
        </defs>
        {/* Roles (left column right edge ~x=171) → Gateway (center x=300) */}
        <path d="M 171 40 Q 235 40 300 120" className="animate-topology-flow" stroke="url(#flow-grad)" strokeWidth="1" fill="none" />
        <path d="M 171 120 Q 235 120 300 120" className="animate-topology-flow [animation-delay:800ms]" stroke="url(#flow-grad)" strokeWidth="1" fill="none" />
        <path d="M 171 200 Q 235 200 300 120" className="animate-topology-flow [animation-delay:1600ms]" stroke="url(#flow-grad)" strokeWidth="1" fill="none" />
        {/* Gateway (x=300) → Connections (right column left edge ~x=429) */}
        <path d="M 300 120 Q 365 40 429 40" className="animate-topology-flow [animation-delay:400ms]" stroke="url(#flow-grad)" strokeWidth="1" fill="none" />
        <path d="M 300 120 Q 365 90 429 90" className="animate-topology-flow [animation-delay:1200ms]" stroke="url(#flow-grad)" strokeWidth="1" fill="none" />
        <path d="M 300 120 Q 365 150 429 150" className="animate-topology-flow [animation-delay:2000ms]" stroke="url(#flow-grad)" strokeWidth="1" fill="none" />
        <path d="M 300 120 Q 365 200 429 200" className="animate-topology-flow [animation-delay:2800ms]" stroke="url(#flow-grad)" strokeWidth="1" fill="none" />
      </svg>
    </div>
  )
}
