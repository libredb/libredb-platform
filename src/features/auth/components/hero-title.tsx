export function HeroTitle() {
  return (
    <div>
      <div className="mb-3 inline-flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-[0.25em] text-chart-4">
        <span className="inline-block h-px w-6 bg-chart-4" aria-hidden="true" />
        Database Access Governance
      </div>
      <h1 className="font-heading font-semibold tracking-tight leading-[1.02] text-4xl lg:text-5xl xl:text-6xl">
        <span className="block text-foreground animate-hero-cascade [animation-delay:0ms]">
          Authorize.
        </span>
        <span className="block text-muted-foreground animate-hero-cascade [animation-delay:120ms] mt-1">
          Audit.
        </span>
        <span
          className="block mt-1 bg-clip-text text-transparent bg-[linear-gradient(90deg,var(--primary),var(--chart-4),var(--primary))] animate-govern-gradient animate-hero-cascade [animation-delay:240ms]"
        >
          Govern.
        </span>
      </h1>
    </div>
  )
}
