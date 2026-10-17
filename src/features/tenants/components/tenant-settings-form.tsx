'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { useAction } from '@/shared/hooks/use-action'
import { updateSettings, type UpdateSettingsData } from '../actions/update-settings'

const settingsSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  logoUrl: z.string().url('Must be a valid URL').or(z.literal('')).optional(),
})

interface TenantSettingsFormProps {
  tenant: {
    name: string
    logoUrl: string | null
  }
}

export function TenantSettingsForm({ tenant }: TenantSettingsFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<UpdateSettingsData>({
    resolver: zodResolver(settingsSchema) as any,
    defaultValues: {
      name: tenant.name,
      logoUrl: tenant.logoUrl ?? '',
    },
  })

  const { execute, isPending } = useAction(updateSettings, {
    successMessage: 'Settings saved successfully',
  })

  const onSubmit = (data: UpdateSettingsData) => {
    execute(data)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-lg space-y-6">
      {/* General Section */}
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Basic organization information.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Tenant Name</Label>
            <Input
              id="name"
              placeholder="My Organization"
              {...register('name')}
            />
            {errors.name && (
              <p className="text-xs text-destructive">
                {errors.name.message as string}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="logoUrl">Logo URL</Label>
            <Input
              id="logoUrl"
              placeholder="https://example.com/logo.png"
              {...register('logoUrl')}
            />
            {errors.logoUrl && (
              <p className="text-xs text-destructive">
                {errors.logoUrl.message as string}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              URL to your organization logo. Leave empty for default.
            </p>
          </div>
        </CardContent>
      </Card>

      <Button type="submit" disabled={isPending}>
        {isPending ? 'Saving...' : 'Save Settings'}
      </Button>
    </form>
  )
}
