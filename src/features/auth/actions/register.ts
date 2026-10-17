'use server'

import { Prisma } from '@prisma/client'
import { signIn } from '@/shared/lib/auth'
import { db } from '@/shared/lib/db'
import { isSelfHosted } from '@/shared/lib/deployment'
import { AppError } from '@/shared/lib/errors'
import { normalizeEmail } from '@/shared/lib/identity/authorize-credentials'
import { registerSchema } from '../lib/auth.schema'
import { logger } from '@/shared/lib/logger'
import bcrypt from 'bcryptjs'

const EMAIL_TAKEN = 'EMAIL_TAKEN'

function emailTakenError(): AppError {
  return new AppError('An account with this email already exists', EMAIL_TAKEN, 409)
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

interface RegisterState {
  error: string | null
  fieldErrors?: Record<string, string>
}

export async function registerAction(_prevState: RegisterState, formData: FormData): Promise<RegisterState> {
  // Self-hosted users come from Keycloak, so registration never reaches the database.
  if (isSelfHosted()) {
    return { error: 'Registration is disabled' }
  }

  const raw = {
    name: formData.get('name') as string,
    email: formData.get('email') as string,
    password: formData.get('password') as string,
    tenantName: formData.get('tenantName') as string,
  }

  const parsed = registerSchema.safeParse(raw)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path[0] as string] = issue.message
    }
    return { error: 'Validation failed', fieldErrors }
  }

  const { name, password, tenantName } = parsed.data
  // The sign-in name of the password credential, so an email that differs only in case is the same account.
  const email = normalizeEmail(parsed.data.email)

  logger.info('Registration attempt', { email, tenantName })

  try {
    const passwordHash = await bcrypt.hash(password, 12)

    // Find FREE plan
    const freePlan = await db.planConfig.findUnique({ where: { code: 'FREE' } })
    if (!freePlan) {
      logger.error('FREE plan config not found: run prisma db seed')
      return { error: 'System configuration error. Please contact support.' }
    }

    // Find TENANT_ADMIN system role
    const tenantAdminRole = await db.role.findFirst({
      where: { code: 'TENANT_ADMIN', isSystem: true },
    })
    if (!tenantAdminRole) {
      logger.error('TENANT_ADMIN role not found: run prisma db seed')
      return { error: 'System configuration error. Please contact support.' }
    }

    // Generate unique slug
    let slug = slugify(tenantName)
    const existingTenant = await db.tenant.findUnique({ where: { slug } })
    if (existingTenant) {
      slug = `${slug}-${Date.now().toString(36)}`
    }

    // Create everything in a transaction. The email check runs inside it, and the unique
    // password_credentials.email decides between two registrations of the same email.
    await db.$transaction(async (tx) => {
      const existingCredential = await tx.passwordCredential.findUnique({
        where: { email },
        select: { userId: true },
      })
      if (existingCredential) {
        throw emailTakenError()
      }

      const user = await tx.user.create({
        data: {
          email,
          name,
          active: true,
          emailVerified: false,
        },
      })

      try {
        await tx.passwordCredential.create({
          data: { userId: user.id, email, passwordHash },
        })
      } catch (error: unknown) {
        // The user id is new, so a unique violation here is the email.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw emailTakenError()
        }
        throw error
      }

      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          slug,
          active: true,
          planConfigId: freePlan.id,
        },
      })

      const membership = await tx.tenantMember.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          isDefault: true,
          active: true,
        },
      })

      await tx.userRole.create({
        data: {
          membershipId: membership.id,
          roleId: tenantAdminRole.id,
        },
      })
    })

    logger.info('Registration successful', { email, tenantName, slug })

    // Auto sign in
    await signIn('credentials', {
      email,
      password,
      redirectTo: '/',
    })
  } catch (error: unknown) {
    // Auth.js throws a NEXT_REDIRECT error on success: rethrow it
    if (error instanceof Error && 'digest' in error && typeof (error as Error & { digest: string }).digest === 'string' && (error as Error & { digest: string }).digest.includes('NEXT_REDIRECT')) {
      throw error
    }
    if (error instanceof AppError && error.code === EMAIL_TAKEN) {
      return { error: error.message }
    }
    logger.error('Registration failed', error instanceof Error ? error : new Error(String(error)))
    return { error: 'Registration failed. Please try again.' }
  }

  return { error: null }
}
