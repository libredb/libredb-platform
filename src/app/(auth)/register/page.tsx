import Link from 'next/link'
import { RegisterForm } from '@/features/auth'
import { Card, CardContent } from '@/shared/components/ui/card'
import { notFoundInSelfHosted } from '@/shared/lib/deployment'

export default async function RegisterPage() {
  await notFoundInSelfHosted()
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Create Account</h1>
        <p className="text-sm text-muted-foreground">Start managing your databases</p>
      </div>

      <Card>
        <CardContent className="p-6">
          <RegisterForm />
        </CardContent>
      </Card>

      <div className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="text-primary underline">
          Sign in
        </Link>
      </div>
    </div>
  )
}
