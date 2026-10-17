import { getCurrentUser } from '@/shared/lib/auth-utils'
import { hasFeature } from '@/shared/lib/feature-flags'

interface FeatureGateProps {
  feature: string
  children: React.ReactNode
  fallback?: React.ReactNode
}

export async function FeatureGate({ feature, children, fallback }: FeatureGateProps) {
  const user = await getCurrentUser()
  if (!user.currentTenantId) return null

  const enabled = await hasFeature(user.currentTenantId, feature)
  if (enabled) return <>{children}</>
  return fallback ? <>{fallback}</> : (
    <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
      <p>This feature requires a plan upgrade.</p>
    </div>
  )
}
