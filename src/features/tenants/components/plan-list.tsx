'use client'

import { useState } from 'react'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { PencilIcon, CheckIcon, XIcon } from 'lucide-react'
import { PlanForm } from './plan-form'

interface PlanItem {
  id: string
  code: string
  name: string
  description: string | null
  isDefault: boolean
  sortOrder: number
  maxUsers: number
  maxConnections: number
  queryHistoryDays: number
  featureSharedQueries: boolean
  featureAdvancedRbac: boolean
  featureAuditLog: boolean
  featurePerfTracking: boolean
  featureDataMasking: boolean
  featureSamlSso: boolean
  featureScimProvisioning: boolean
  featureSelfHosted: boolean
  featureApiAccess: boolean
  pricePerUserMonthly: string | null
}

interface PlanListProps {
  plans: PlanItem[]
}

function FeatureIcon({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <CheckIcon className="size-4 text-green-600" />
  ) : (
    <XIcon className="size-4 text-muted-foreground/40" />
  )
}

export function PlanList({ plans }: PlanListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)

  const editingPlan = plans.find((p) => p.id === editingId)

  if (editingPlan) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">
            Edit Plan: {editingPlan.name}
          </h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditingId(null)}
          >
            Back to List
          </Button>
        </div>
        <PlanForm plan={editingPlan} onDone={() => setEditingId(null)} />
      </div>
    )
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Plan</TableHead>
            <TableHead>Users</TableHead>
            <TableHead>Connections</TableHead>
            <TableHead>History</TableHead>
            <TableHead>Shared Queries</TableHead>
            <TableHead>RBAC</TableHead>
            <TableHead>Audit</TableHead>
            <TableHead>Price/User/Mo</TableHead>
            <TableHead className="w-[80px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={9}
                className="h-24 text-center text-muted-foreground"
              >
                No plans configured.
              </TableCell>
            </TableRow>
          ) : (
            plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{plan.name}</span>
                    {plan.isDefault && (
                      <Badge variant="secondary" className="text-[10px]">
                        Default
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{plan.code}</p>
                </TableCell>
                <TableCell>{plan.maxUsers}</TableCell>
                <TableCell>{plan.maxConnections}</TableCell>
                <TableCell>{plan.queryHistoryDays}d</TableCell>
                <TableCell>
                  <FeatureIcon enabled={plan.featureSharedQueries} />
                </TableCell>
                <TableCell>
                  <FeatureIcon enabled={plan.featureAdvancedRbac} />
                </TableCell>
                <TableCell>
                  <FeatureIcon enabled={plan.featureAuditLog} />
                </TableCell>
                <TableCell>
                  {plan.pricePerUserMonthly
                    ? `$${plan.pricePerUserMonthly}`
                    : 'Free'}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditingId(plan.id)}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
