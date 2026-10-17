import { getCurrentUser } from '@/shared/lib/auth-utils'

interface PermissionGateProps {
  permission: string
  children: React.ReactNode
  fallback?: React.ReactNode
}

export async function PermissionGate({ permission, children, fallback }: PermissionGateProps) {
  const user = await getCurrentUser()
  const isPlatformAdmin = user.roles.includes('PLATFORM_ADMIN')
  const hasPermission = isPlatformAdmin || user.permissions.includes(permission)

  if (hasPermission) return <>{children}</>
  return fallback ? <>{fallback}</> : null
}
