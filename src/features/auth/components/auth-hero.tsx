import { HeroStatusBar } from './hero-status-bar'
import { HeroTitle } from './hero-title'
import { GovernanceTopology } from './governance-topology'
import { SupportedEngines } from './supported-engines'

/**
 * Full Control Tower hero for the auth layout. Composed of leaf components
 * under `features/auth/components/`. Rendered only on `lg:` and above; see
 * `auth` layout for responsive collapse rules.
 *
 * DNA notes on what this hero must and must NOT do on the pre-auth page:
 *
 * DOES NOT show:
 *   • A live audit stream: reads as a leak of real customer activity
 *   • A platform-wide "queries today" counter: same concern, plus the number
 *     can either look tiny (undermines scale) or be contested
 *   • Other tenant names: suggests data mixing, breaks multi-tenant promise
 *
 * DOES show (all aggregate and self-scoped):
 *   • Topology of a SINGLE tenant: your roles → governance → your connections
 *   • Platform-level status bar (region / uptime / UTC clock)
 *   • The full list of supported database engines as a capability strip
 */
export function AuthHero() {
  return (
    <div
      className="relative hidden h-full flex-col overflow-hidden px-10 py-8 lg:flex"
      style={{
        backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(
          `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28'><circle cx='2' cy='2' r='1' fill='%23e8ecf7' opacity='0.05'/></svg>`,
        )}")`,
      }}
    >
      <HeroStatusBar />

      <div className="mt-8">
        <HeroTitle />
      </div>

      <div className="mt-8 flex-1">
        <GovernanceTopology />
      </div>

      <div className="mt-6">
        <SupportedEngines />
      </div>
    </div>
  )
}
