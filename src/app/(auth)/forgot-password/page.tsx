import Link from 'next/link'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent } from '@/shared/components/ui/card'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { notFoundInSelfHosted } from '@/shared/lib/deployment'

export default async function ForgotPasswordPage() {
  await notFoundInSelfHosted()
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Reset Password</h1>
        <p className="text-sm text-muted-foreground">Enter your email to receive a reset link</p>
      </div>

      <Card>
        <CardContent className="p-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="you@example.com" />
        </div>

        <Button className="w-full" disabled>
          Send Reset Link (Coming Soon)
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          Email sending will be available in a future update.
        </p>
        </CardContent>
      </Card>

      <div className="text-center text-sm text-muted-foreground">
        Remember your password?{' '}
        <Link href="/login" className="text-primary underline">
          Sign in
        </Link>
      </div>
    </div>
  )
}
