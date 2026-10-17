import { getCurrentUser } from '@/shared/lib/auth-utils'

interface RoleGateProps {
  roles: string[]
  children: React.ReactNode
  fallback?: React.ReactNode
}

export async function RoleGate({ roles, children, fallback }: RoleGateProps) {
  const user = await getCurrentUser()
  const hasRole = user.roles.some(r => roles.includes(r))

  if (hasRole) return <>{children}</>
  return fallback ? <>{fallback}</> : null
}
