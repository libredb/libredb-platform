import type { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { membershipAccess } from './credentials-session'

/** The Prisma delegates a Credentials sign-in uses, injected so that the sign-in logic runs without the shared client. */
export type CredentialsClient = Pick<PrismaClient, 'passwordCredential' | 'user'>

/** The user that the Credentials provider hands to the jwt callback. */
export interface CredentialsUser {
  id: string
  email: string
  name: string | null
  currentTenantId: string | null
  membershipId: string | null
  roles: string[]
  permissions: string[]
  accessibleTenants: { id: string; name: string; slug: string }[]
}

/** The sign-in name of a password credential, trimmed and lower-cased as password_credentials stores it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * The authorize step of the Credentials provider, which cloud mode uses.
 * Looks the email up in password_credentials, never in users, whose email is only a label that two users may share.
 * Returns null for missing credentials, an unknown email, an inactive user or a wrong password.
 */
export async function authorizeCredentials(
  client: CredentialsClient,
  credentials: Partial<Record<'email' | 'password', unknown>>,
): Promise<CredentialsUser | null> {
  const { email, password } = credentials
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return null

  const credential = await client.passwordCredential.findUnique({
    where: { email: normalizeEmail(email) },
    include: {
      user: {
        include: {
          memberships: {
            where: { active: true },
            include: {
              tenant: { select: { id: true, name: true, slug: true } },
              roles: {
                include: {
                  role: {
                    include: { permissions: { include: { permission: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  })

  if (!credential || !credential.user.active) return null

  const isValid = await bcrypt.compare(password, credential.passwordHash)
  if (!isValid) return null

  const { user } = credential
  await client.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  })

  const defaultMembership = user.memberships.find(m => m.isDefault) ?? user.memberships[0]
  const { roles, permissions } = membershipAccess(defaultMembership?.roles ?? [])

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    currentTenantId: defaultMembership?.tenantId ?? null,
    membershipId: defaultMembership?.id ?? null,
    roles,
    permissions,
    accessibleTenants: user.memberships.map(m => ({
      id: m.tenant.id,
      name: m.tenant.name,
      slug: m.tenant.slug,
    })),
  }
}
