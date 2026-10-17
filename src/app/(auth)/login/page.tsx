import Link from 'next/link'
import { LoginForm } from '@/features/auth'
import { SignInError } from '@/features/auth/components/sign-in-error'
import { SSOButton } from '@/features/auth/components/sso-button'
import { getRuntimeConfig } from '@/shared/lib/runtime-config'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // Reading searchParams renders the page per request, so the deployment mode is read at runtime, never at build time.
  const { error } = await searchParams
  const config = getRuntimeConfig()
  // Self-hosted mode signs in only through Keycloak, cloud mode only with a password.
  const selfHosted = config.DEPLOYMENT_MODE === 'self-hosted'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">Continue to your workspace.</p>
      </div>

      {typeof error === 'string' && <SignInError code={error} studioUrl={config.STUDIO_PUBLIC_URL} />}

      {selfHosted ? (
        <SSOButton />
      ) : (
        <>
          <LoginForm />

          <div className="pt-2 text-center text-sm text-muted-foreground">
            No account yet?{' '}
            <Link href="/register" className="font-medium text-chart-4 hover:underline underline-offset-4">
              Start free trial
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
