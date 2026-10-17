import { type badgeVariants } from '@/shared/components/ui/badge'
import { type VariantProps } from 'class-variance-authority'

type BadgeVariant = VariantProps<typeof badgeVariants>['variant']

/**
 * Maps a plan code to a Badge variant. Kept in `lib/` (not a component)
 * so both server-rendered tables and client tabs can reuse the same rules.
 */
export function planBadgeVariant(code: string | undefined): BadgeVariant {
  switch (code) {
    case 'FREE':
      return 'secondary'
    case 'TEAM':
      return 'default'
    case 'BUSINESS':
      return 'success'
    case 'ENTERPRISE':
      return 'warning'
    default:
      return 'outline'
  }
}
