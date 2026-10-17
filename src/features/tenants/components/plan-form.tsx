'use client'

import { useForm } from 'react-hook-form'
import { Button } from '@/shared/components/ui/button'
import { Checkbox } from '@/shared/components/ui/checkbox'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { useAction } from '@/shared/hooks/use-action'
import { updatePlan, type UpdatePlanData } from '../actions/update-plan'

interface PlanFormProps {
  plan: {
    id: string
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
  onDone: () => void
}

const FEATURE_FLAGS = [
  { key: 'featureSharedQueries', label: 'Shared Queries' },
  { key: 'featureAdvancedRbac', label: 'Advanced RBAC' },
  { key: 'featureAuditLog', label: 'Audit Log' },
  { key: 'featurePerfTracking', label: 'Performance Tracking' },
  { key: 'featureDataMasking', label: 'Data Masking' },
  { key: 'featureSamlSso', label: 'SAML SSO' },
  { key: 'featureScimProvisioning', label: 'SCIM Provisioning' },
  { key: 'featureSelfHosted', label: 'Self-Hosted' },
  { key: 'featureApiAccess', label: 'API Access' },
] as const

type FeatureKey = (typeof FEATURE_FLAGS)[number]['key']

interface FormValues {
  id: string
  name: string
  description: string
  maxUsers: number
  maxConnections: number
  queryHistoryDays: number
  pricePerUserMonthly: string
  featureSharedQueries: boolean
  featureAdvancedRbac: boolean
  featureAuditLog: boolean
  featurePerfTracking: boolean
  featureDataMasking: boolean
  featureSamlSso: boolean
  featureScimProvisioning: boolean
  featureSelfHosted: boolean
  featureApiAccess: boolean
}

export function PlanForm({ plan, onDone }: PlanFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: {
      id: plan.id,
      name: plan.name,
      description: plan.description ?? '',
      maxUsers: plan.maxUsers,
      maxConnections: plan.maxConnections,
      queryHistoryDays: plan.queryHistoryDays,
      pricePerUserMonthly: plan.pricePerUserMonthly ?? '',
      featureSharedQueries: plan.featureSharedQueries,
      featureAdvancedRbac: plan.featureAdvancedRbac,
      featureAuditLog: plan.featureAuditLog,
      featurePerfTracking: plan.featurePerfTracking,
      featureDataMasking: plan.featureDataMasking,
      featureSamlSso: plan.featureSamlSso,
      featureScimProvisioning: plan.featureScimProvisioning,
      featureSelfHosted: plan.featureSelfHosted,
      featureApiAccess: plan.featureApiAccess,
    },
  })

  const { execute, isPending } = useAction(updatePlan, {
    successMessage: 'Plan updated successfully',
    onSuccess: () => onDone(),
  })

  const onSubmit = (data: FormValues) => {
    execute({
      ...data,
      maxUsers: Number(data.maxUsers),
      maxConnections: Number(data.maxConnections),
      queryHistoryDays: Number(data.queryHistoryDays),
    } as unknown as UpdatePlanData)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-lg space-y-6">
      <div className="space-y-2">
        <Label htmlFor="code">Code</Label>
        <Input id="code" value={plan.code} disabled className="bg-muted" />
        <p className="text-xs text-muted-foreground">
          Plan code cannot be changed.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" {...register('name')} />
        {errors.name && (
          <p className="text-xs text-destructive">
            {errors.name.message as string}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Input id="description" {...register('description')} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor="maxUsers">Max Users</Label>
          <Input
            id="maxUsers"
            type="number"
            min={1}
            {...register('maxUsers', { valueAsNumber: true })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="maxConnections">Max Connections</Label>
          <Input
            id="maxConnections"
            type="number"
            min={1}
            {...register('maxConnections', { valueAsNumber: true })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="queryHistoryDays">History Days</Label>
          <Input
            id="queryHistoryDays"
            type="number"
            min={1}
            {...register('queryHistoryDays', { valueAsNumber: true })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="pricePerUserMonthly">Price per User/Month ($)</Label>
        <Input
          id="pricePerUserMonthly"
          placeholder="0.00 (leave empty for free)"
          {...register('pricePerUserMonthly')}
        />
      </div>

      <div className="space-y-3">
        <Label>Feature Flags</Label>
        <div className="grid grid-cols-2 gap-2">
          {FEATURE_FLAGS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2">
              <Checkbox
                checked={watch(key as FeatureKey)}
                onCheckedChange={(checked) => setValue(key as FeatureKey, !!checked)}
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving...' : 'Save Plan'}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
