'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { loginAction } from '../actions/login'
import { Alert, AlertDescription } from '@/shared/components/ui/alert'
import { AlertCircle } from 'lucide-react'

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(loginAction, { error: null })

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-1.5">
        <label
          htmlFor="email"
          className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          className="w-full border-b border-border/60 bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-chart-4 focus-visible:ring-0"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <label
            htmlFor="password"
            className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
          >
            Password
          </label>
          <Link
            href="/forgot-password"
            className="text-[11px] text-primary hover:underline underline-offset-2"
          >
            Forgot?
          </Link>
        </div>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          className="w-full border-b border-border/60 bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-chart-4 focus-visible:ring-0"
        />
      </div>

      {state?.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-bold text-background transition hover:opacity-90 disabled:opacity-60"
      >
        {isPending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
