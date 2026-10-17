import { redirect } from 'next/navigation'
import { requireAuth } from '@/shared/lib/auth-utils'
import { landingPathFor } from '@/shared/lib/landing'

export default async function HomePage() {
  const user = await requireAuth()
  redirect(landingPathFor(user))
}
