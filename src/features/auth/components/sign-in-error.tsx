import { AlertCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert'
import { LicenseLimitError } from '@/shared/lib/errors'
import { IDENTITY_CLAIM_MISSING } from '@/shared/lib/identity/auth-callbacks'
import { SINGLE_LOGOUT_FAILED } from '@/shared/lib/identity/end-session'

/** The error type that Auth.js puts on the login page when the signIn callback refuses a sign-in. */
const ACCESS_DENIED = 'AccessDenied'

interface SignInErrorProps {
  /** The `error` query parameter of /login, set by Auth.js or by the signIn callback. */
  code: string
  /** STUDIO_PUBLIC_URL, where an account with the user role works instead of Platform. */
  studioUrl: string | undefined
}

function Explanation({ code, studioUrl }: SignInErrorProps) {
  if (code === ACCESS_DENIED) {
    return (
      <>
        <AlertTitle>Platform requires the admin role</AlertTitle>
        <AlertDescription>
          {studioUrl ? (
            <>Accounts with the user role work in <a href={studioUrl}>LibreDB Studio</a>.</>
          ) : (
            'Ask your administrator for access.'
          )}
        </AlertDescription>
      </>
    )
  }
  if (code === IDENTITY_CLAIM_MISSING) {
    return (
      <>
        <AlertTitle>Your account has no email address</AlertTitle>
        <AlertDescription>
          Platform needs the email of your account. Ask your administrator to add one, then sign in again.
        </AlertDescription>
      </>
    )
  }
  // The license refuses the first sign-in of an admin without a free admin seat, after its expiry, or when it could not
  // be verified, with the same text as any write it refuses.
  if (code === 'LICENSE_ADMIN_SEATS') {
    return (
      <>
        <AlertTitle>Your first sign-in needs a free admin seat</AlertTitle>
        <AlertDescription>{new LicenseLimitError(code).message}</AlertDescription>
      </>
    )
  }
  if (code === 'LICENSE_EXPIRED') {
    return (
      <>
        <AlertTitle>Your first sign-in needs a renewed license</AlertTitle>
        <AlertDescription>{new LicenseLimitError(code).message}</AlertDescription>
      </>
    )
  }
  if (code === 'LICENSE_INVALID') {
    return (
      <>
        <AlertTitle>Your first sign-in needs a valid license</AlertTitle>
        <AlertDescription>{new LicenseLimitError(code).message}</AlertDescription>
      </>
    )
  }
  if (code === SINGLE_LOGOUT_FAILED) {
    return (
      <>
        <AlertTitle>You are signed out of Platform only</AlertTitle>
        <AlertDescription>
          Your single sign-on session could not be ended, so signing in again may skip the password form. Close the
          browser to end it, and ask your administrator to check the Platform logs.
        </AlertDescription>
      </>
    )
  }
  return (
    <>
      <AlertTitle>Sign-in failed</AlertTitle>
      <AlertDescription>Try again. If it keeps failing, ask your administrator to check the Platform logs.</AlertDescription>
    </>
  )
}

/**
 * Explains why a sign-in failed, or why a logout ended only the Platform session.
 * The code comes from the URL, so an unknown code gets a fixed message and never appears on the page.
 */
export function SignInError({ code, studioUrl }: SignInErrorProps) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <Explanation code={code} studioUrl={studioUrl} />
    </Alert>
  )
}
