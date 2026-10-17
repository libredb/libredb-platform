'use client'

import { useActionState } from 'react'
import { registerAction } from '../actions/register'
import { Alert, AlertDescription } from '@/shared/components/ui/alert'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { AlertCircle } from 'lucide-react'

export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(registerAction, { error: null })

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Full Name</Label>
        <Input id="name" name="name" placeholder="Sarah Chen" required autoComplete="name" />
        {state?.fieldErrors?.name && (
          <p className="text-xs text-destructive">{state.fieldErrors.name}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" placeholder="sarah@acme.com" required autoComplete="email" />
        {state?.fieldErrors?.email && (
          <p className="text-xs text-destructive">{state.fieldErrors.email}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" placeholder="Min 8 characters" required autoComplete="new-password" />
        {state?.fieldErrors?.password && (
          <p className="text-xs text-destructive">{state.fieldErrors.password}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="tenantName">Organization Name</Label>
        <Input id="tenantName" name="tenantName" placeholder="Acme Corp" required />
        {state?.fieldErrors?.tenantName && (
          <p className="text-xs text-destructive">{state.fieldErrors.tenantName}</p>
        )}
      </div>

      {state?.error && !state?.fieldErrors && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? 'Creating account...' : 'Create account'}
      </Button>
    </form>
  )
}
