import { TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert'
import { cn } from '@/shared/lib/utils'

interface DirectoryDegradedBannerProps {
  /** The directoryDegraded flag of the session: true while the session recheck cannot reach the Keycloak Admin API. */
  directoryDegraded: boolean
  className?: string
}

/**
 * Tells a Keycloak admin that the session lives on its grace: Platform keeps the session for
 * PLATFORM_RECHECK_GRACE_SECONDS after the last successful recheck and refuses the actions that read the directory.
 * It renders nothing while the directory answers.
 */
export function DirectoryDegradedBanner({ directoryDegraded, className }: DirectoryDegradedBannerProps) {
  if (!directoryDegraded) return null
  return (
    <Alert
      role="status"
      className={cn('border-amber-500/50 bg-amber-500/5 text-amber-700 dark:text-amber-400', className)}
    >
      <TriangleAlert />
      <AlertTitle>Keycloak is unreachable</AlertTitle>
      <AlertDescription>
        Platform cannot recheck your session against the Keycloak directory, so your session ends if Keycloak stays
        unreachable. Actions that need the Keycloak directory are disabled until it answers again.
      </AlertDescription>
    </Alert>
  )
}
