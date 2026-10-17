'use client'

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/shared/components/ui/tooltip'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { CheckIcon, XIcon } from 'lucide-react'

interface PlanInfo {
  code: string
  name: string
  description: string | null
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

interface UsageInfo {
  currentUsers: number
  currentConnections: number
}

interface BillingPageContentProps {
  currentPlan: PlanInfo
  usage: UsageInfo
  allPlans: PlanInfo[]
  billingEnabled: boolean
}

const FEATURE_LABELS: { key: keyof PlanInfo; label: string }[] = [
  { key: 'featureSharedQueries', label: 'Shared Queries' },
  { key: 'featureAdvancedRbac', label: 'Advanced RBAC' },
  { key: 'featureAuditLog', label: 'Audit Log' },
  { key: 'featurePerfTracking', label: 'Performance Tracking' },
  { key: 'featureDataMasking', label: 'Data Masking' },
  { key: 'featureSamlSso', label: 'SAML SSO' },
  { key: 'featureScimProvisioning', label: 'SCIM Provisioning' },
  { key: 'featureSelfHosted', label: 'Self-Hosted' },
  { key: 'featureApiAccess', label: 'API Access' },
]

function FeatureCheck({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <CheckIcon className="size-4 text-green-600" />
  ) : (
    <XIcon className="size-4 text-muted-foreground/40" />
  )
}

function UsageBar({
  current,
  max,
  label,
}: {
  current: number
  max: number
  label: string
}) {
  const pct = Math.min((current / max) * 100, 100)
  const isWarning = pct >= 80
  const isFull = pct >= 100

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="font-medium">
          {current} / {max}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${
            isFull
              ? 'bg-destructive'
              : isWarning
                ? 'bg-yellow-500'
                : 'bg-primary'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function BillingPageContent({
  currentPlan,
  usage,
  allPlans,
  billingEnabled,
}: BillingPageContentProps) {
  return (
    <div className="space-y-8">
      {/* Current Plan Card */}
      <Card className="bg-primary/5 border-primary/20">
        <CardHeader>
          <div className="flex items-center gap-3">
            <CardTitle>Current Plan</CardTitle>
            <Badge>{currentPlan.name}</Badge>
          </div>
          <CardDescription>
            {currentPlan.description ?? 'Your current subscription plan.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-bold">
            {currentPlan.pricePerUserMonthly
              ? `$${currentPlan.pricePerUserMonthly}`
              : 'Free'}
            {currentPlan.pricePerUserMonthly && (
              <span className="text-base font-normal text-muted-foreground">
                {' '}
                / user / month
              </span>
            )}
          </p>
        </CardContent>
      </Card>

      {/* Usage Section */}
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>
            Current resource usage against your plan limits.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <UsageBar
            current={usage.currentUsers}
            max={currentPlan.maxUsers}
            label="Team Members"
          />
          <UsageBar
            current={usage.currentConnections}
            max={currentPlan.maxConnections}
            label="Database Connections"
          />
          <div className="flex items-center justify-between text-sm">
            <span>Query History Retention</span>
            <span className="font-medium">
              {currentPlan.queryHistoryDays} days
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Plan Comparison Table */}
      <Card>
        <CardHeader>
          <CardTitle>Compare Plans</CardTitle>
          <CardDescription>
            Choose the best plan for your team.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                {allPlans.map((plan) => (
                  <TableHead
                    key={plan.code}
                    className={`text-center ${plan.code === currentPlan.code ? 'bg-primary/5' : ''}`}
                  >
                    <div className="flex flex-col items-center gap-1">
                      <span className="font-semibold">{plan.name}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {plan.pricePerUserMonthly
                          ? `$${plan.pricePerUserMonthly}/user/mo`
                          : 'Free'}
                      </span>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Max Users</TableCell>
                {allPlans.map((plan) => (
                  <TableCell key={plan.code} className={`text-center ${plan.code === currentPlan.code ? 'bg-primary/5' : ''}`}>
                    {plan.maxUsers}
                  </TableCell>
                ))}
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Max Connections</TableCell>
                {allPlans.map((plan) => (
                  <TableCell key={plan.code} className={`text-center ${plan.code === currentPlan.code ? 'bg-primary/5' : ''}`}>
                    {plan.maxConnections}
                  </TableCell>
                ))}
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">
                  Query History (days)
                </TableCell>
                {allPlans.map((plan) => (
                  <TableCell key={plan.code} className={`text-center ${plan.code === currentPlan.code ? 'bg-primary/5' : ''}`}>
                    {plan.queryHistoryDays}
                  </TableCell>
                ))}
              </TableRow>
              {FEATURE_LABELS.map(({ key, label }) => (
                <TableRow key={key}>
                  <TableCell className="font-medium">{label}</TableCell>
                  {allPlans.map((plan) => (
                    <TableCell key={plan.code} className={`text-center ${plan.code === currentPlan.code ? 'bg-primary/5' : ''}`}>
                      <div className="flex justify-center">
                        <FeatureCheck enabled={plan[key] as boolean} />
                      </div>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        <CardFooter className="flex justify-center gap-4">
          <TooltipProvider>
            {allPlans
              .filter((p) => p.code !== currentPlan.code)
              .map((plan) => (
                <Tooltip key={plan.code}>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        disabled={!billingEnabled}
                      >
                        Upgrade to {plan.name}
                      </Button>
                    }
                  />
                  {!billingEnabled && (
                    <TooltipContent>Coming soon</TooltipContent>
                  )}
                </Tooltip>
              ))}
          </TooltipProvider>
        </CardFooter>
      </Card>
    </div>
  )
}
