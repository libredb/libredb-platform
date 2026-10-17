import { AuthHero } from '@/features/auth/components/auth-hero'
import { LogoMark } from '@/features/auth/components/logo-mark'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[1fr_420px]">
      {/* Hero (hidden on mobile, compact on tablet) */}
      <aside className="bg-sidebar text-foreground">
        <AuthHero />
        {/* Tablet/mobile: compact brand + kicker only */}
        <div className="flex flex-col gap-6 px-8 py-10 lg:hidden">
          <LogoMark />
          <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-chart-4">
            Database Access Governance
          </div>
          <h1 className="font-heading text-3xl font-semibold leading-tight tracking-tight">
            Authorize. Audit.{' '}
            <span className="bg-clip-text text-transparent bg-[linear-gradient(90deg,var(--primary),var(--chart-4))]">
              Govern.
            </span>
          </h1>
        </div>
      </aside>

      {/* Form panel */}
      <main className="flex flex-col border-l border-border bg-background px-10 py-12 lg:h-screen">
        <div className="hidden lg:block">
          <LogoMark />
        </div>

        {/* Scrollable middle region: keeps LogoMark + footer pinned on tall forms */}
        <div className="flex flex-1 items-center justify-center overflow-y-auto py-6">
          <div className="mx-auto w-full max-w-[340px]">{children}</div>
        </div>

        <div className="hidden text-[10px] text-muted-foreground/60 lg:block">
          © {new Date().getFullYear()} SEKOYA GRUP BİLİŞİM VE TEKNOLOJİ LİMİTED ŞİRKETİ
        </div>
      </main>
    </div>
  )
}
