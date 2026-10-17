import { ShieldCheck } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { signInWithOidc } from '../actions/sign-in-oidc'

/**
 * The sign-in of self-hosted mode, where Keycloak is the only provider.
 * The form submits the `signInWithOidc` Server Action, which starts the Keycloak sign-in and is protected against
 * CSRF by Next.js.
 */
export function SSOButton() {
  return (
    <form action={signInWithOidc}>
      <Button
        type="submit"
        variant="outline"
        className="w-full justify-center gap-2 border-border/60 text-foreground hover:bg-muted/40"
      >
        <ShieldCheck className="h-4 w-4 text-chart-4" />
        Continue with SSO
      </Button>
    </form>
  )
}
