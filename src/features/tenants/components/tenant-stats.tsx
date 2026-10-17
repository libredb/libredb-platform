import {
  BuildingIcon,
  CheckCircleIcon,
  PowerOffIcon,
  AlertTriangleIcon,
} from 'lucide-react'
import { StatCard } from '@/shared/components/composed/stat-card'

interface TenantStatsProps {
  total: number
  active: number
  inactive: number
  approachingLimits: number
}

/**
 * KPI strip for the admin tenant list. Server-rendered, no client logic.
 */
export function TenantStats({
  total,
  active,
  inactive,
  approachingLimits,
}: TenantStatsProps) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <StatCard title="Total Tenants" value={total} icon={BuildingIcon} />
      <StatCard
        title="Active"
        value={active}
        icon={CheckCircleIcon}
      />
      <StatCard
        title="Inactive"
        value={inactive}
        icon={PowerOffIcon}
      />
      <StatCard
        title="Approaching Limits"
        value={approachingLimits}
        icon={AlertTriangleIcon}
      />
    </div>
  )
}
