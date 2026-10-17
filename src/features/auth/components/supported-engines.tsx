import { supportedEngines } from '../lib/hero-demo-data'

/**
 * Horizontal strip of supported database engines shown at the bottom of the
 * login hero. Communicates platform breadth without leaking activity data.
 *
 * Pure Server Component: no hooks, no state, no animation. Brand hex colors
 * on the chips are a documented exception to the "tokens only" rule (brand
 * identity, not design-system colors).
 */
export function SupportedEngines() {
  return (
    <div className="border-t border-border/50 pt-4">
      <div className="mb-3 flex items-center gap-2.5 text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground/70">
        <span className="inline-block h-px w-4 bg-muted-foreground/40" aria-hidden="true" />
        Works Across Your Stack · {supportedEngines.length} Engines
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        {supportedEngines.map((e) => (
          <div
            key={e.engine}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <span
              className="flex h-4 w-4 items-center justify-center rounded-sm text-[8px] font-bold text-white"
              style={{ backgroundColor: e.color }}
              aria-hidden="true"
            >
              {e.chip}
            </span>
            <span className="text-foreground/80">{e.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
