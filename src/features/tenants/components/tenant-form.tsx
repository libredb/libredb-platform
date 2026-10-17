'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Switch } from '@/shared/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useAction } from '@/shared/hooks/use-action'
import { createTenant } from '../actions/create-tenant'
import { updateTenant } from '../actions/update-tenant'
import {
  createTenantSchema,
  updateTenantSchema,
  type CreateTenantData,
  type UpdateTenantData,
} from '../lib/tenant.schema'

interface PlanOption {
  id: string
  code: string
  name: string
}

interface TenantFormProps {
  plans: PlanOption[]
  tenant?: {
    id: string
    name: string
    slug: string
    planConfigId: string
    active: boolean
  }
}

export function TenantForm({ plans, tenant }: TenantFormProps) {
  const router = useRouter()
  const isEdit = !!tenant
  const slugTouched = useRef(false)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateTenantData | UpdateTenantData>({
    resolver: zodResolver(isEdit ? updateTenantSchema : createTenantSchema),
    defaultValues: isEdit
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          planConfigId: tenant.planConfigId,
          active: tenant.active,
        }
      : {
          name: '',
          slug: '',
          planConfigId: '',
        },
  })

  const { execute: executeCreate, isPending: isCreating } = useAction(
    createTenant,
    {
      successMessage: 'Tenant created successfully',
      onSuccess: () => router.push('/admin/tenants'),
    },
  )

  const { execute: executeUpdate, isPending: isUpdating } = useAction(
    updateTenant,
    {
      successMessage: 'Tenant updated successfully',
      onSuccess: () => router.push('/admin/tenants'),
    },
  )

  const isPending = isCreating || isUpdating

  const nameValue = watch('name')

  // Auto-generate slug from name (only in create mode and if slug hasn't been manually edited)
  useEffect(() => {
    if (isEdit || slugTouched.current) return
    if (nameValue) {
      const slug = nameValue
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
      setValue('slug', slug)
    }
  }, [nameValue, isEdit, setValue])

  const onSubmit = (data: CreateTenantData | UpdateTenantData) => {
    if (isEdit) {
      executeUpdate(data as UpdateTenantData)
    } else {
      executeCreate(data as CreateTenantData)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-lg space-y-6">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          placeholder="Acme Corporation"
          {...register('name')}
        />
        {errors.name && (
          <p className="text-xs text-destructive">
            {errors.name.message as string}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="slug">Slug</Label>
        <Input
          id="slug"
          placeholder="acme-corporation"
          {...register('slug', {
            onChange: () => {
              slugTouched.current = true
            },
          })}
        />
        {errors.slug && (
          <p className="text-xs text-destructive">
            {errors.slug.message as string}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          URL-friendly identifier. Lowercase letters, numbers, and hyphens only.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="planConfigId">Plan</Label>
        <Select
          defaultValue={isEdit ? tenant.planConfigId : undefined}
          onValueChange={(value) =>
            setValue('planConfigId', value ?? '', { shouldValidate: true })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a plan" />
          </SelectTrigger>
          <SelectContent>
            {plans.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {plan.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.planConfigId && (
          <p className="text-xs text-destructive">
            {errors.planConfigId.message as string}
          </p>
        )}
      </div>

      {isEdit && (
        <div className="flex items-center gap-3">
          <Switch
            checked={watch('active' as any)}
            onCheckedChange={(checked) => setValue('active' as any, checked)}
          />
          <Label>Active</Label>
        </div>
      )}

      <div className="flex gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending
            ? isEdit
              ? 'Saving...'
              : 'Creating...'
            : isEdit
              ? 'Save Changes'
              : 'Create Tenant'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push('/admin/tenants')}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
