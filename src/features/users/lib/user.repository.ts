import { randomBytes } from 'crypto'
import { db } from '@/shared/lib/db'
import { AppError, ForbiddenError, NotFoundError } from '@/shared/lib/errors'
import { isTenantAssignableRole, TENANT_ASSIGNABLE_SYSTEM_ROLES } from '@/shared/lib/permissions'

export class UserRepository {
  static async findByTenant(tenantId: string) {
    return db.tenantMember.findMany({
      where: { tenantId, active: true },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            active: true,
            lastLoginAt: true,
          },
        },
        roles: {
          include: {
            role: { select: { id: true, code: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  static async findAll() {
    return db.tenantMember.findMany({
      where: { active: true },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            active: true,
            lastLoginAt: true,
          },
        },
        tenant: {
          select: { id: true, name: true, slug: true },
        },
        roles: {
          include: {
            role: { select: { id: true, code: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  static async findInvitations(tenantId: string) {
    return db.invitation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    })
  }

  static async findTenantRoles(tenantId: string) {
    const roles = await db.role.findMany({
      where: {
        OR: [
          { tenantId },
          { isSystem: true, code: { in: [...TENANT_ASSIGNABLE_SYSTEM_ROLES] } },
        ],
      },
      select: { id: true, code: true, name: true, isSystem: true, tenantId: true },
      orderBy: { name: 'asc' },
    })
    return roles
      .filter((role) => isTenantAssignableRole(role, tenantId))
      .map(({ id, code, name }) => ({ id, code, name }))
  }

  static async requireAssignableRole(tenantId: string, roleId: string) {
    const role = await db.role.findUnique({
      where: { id: roleId },
      select: { code: true, isSystem: true, tenantId: true },
    })
    if (!role || !isTenantAssignableRole(role, tenantId)) {
      throw new ForbiddenError('role is not assignable in this tenant')
    }
  }

  static async createInvitation(tenantId: string, email: string, roleId: string) {
    // Check if user is already a member
    const existingMember = await db.tenantMember.findFirst({
      where: {
        tenantId,
        user: { email },
        active: true,
      },
    })
    if (existingMember) {
      throw new AppError('User is already a member of this tenant', 'ALREADY_MEMBER', 409)
    }

    // Check for pending invitation
    const existingInvitation = await db.invitation.findUnique({
      where: { tenantId_email: { tenantId, email } },
    })
    if (existingInvitation && !existingInvitation.acceptedAt) {
      throw new AppError('An invitation has already been sent to this email', 'INVITATION_EXISTS', 409)
    }

    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    // Upsert to handle case where previous invitation was accepted
    return db.invitation.upsert({
      where: { tenantId_email: { tenantId, email } },
      create: {
        tenantId,
        email,
        roleId,
        token,
        expiresAt,
      },
      update: {
        roleId,
        token,
        expiresAt,
        acceptedAt: null,
      },
    })
  }

  static async acceptInvitation(token: string, userId: string) {
    const invitation = await db.invitation.findUnique({ where: { token } })
    if (!invitation) throw new NotFoundError('Invitation')
    if (invitation.acceptedAt) {
      throw new AppError('Invitation has already been accepted', 'INVITATION_ACCEPTED', 409)
    }
    if (invitation.expiresAt < new Date()) {
      throw new AppError('Invitation has expired', 'INVITATION_EXPIRED', 410)
    }

    return db.$transaction(async (tx) => {
      // Create membership
      const membership = await tx.tenantMember.create({
        data: {
          tenantId: invitation.tenantId,
          userId,
          isDefault: false,
          active: true,
        },
      })

      // Assign role
      await tx.userRole.create({
        data: {
          membershipId: membership.id,
          roleId: invitation.roleId,
        },
      })

      // Mark invitation as accepted
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      })

      return membership
    })
  }

  static async updateMemberRole(tenantId: string, membershipId: string, roleId: string) {
    const membership = await db.tenantMember.findFirst({
      where: { id: membershipId, tenantId },
    })
    if (!membership) throw new NotFoundError('Membership')

    return db.$transaction(async (tx) => {
      // Remove all existing roles for this membership
      await tx.userRole.deleteMany({
        where: { membershipId },
      })

      // Add new role
      await tx.userRole.create({
        data: { membershipId, roleId },
      })
    })
  }

  static async toggleMemberActive(tenantId: string, membershipId: string, active: boolean) {
    const membership = await db.tenantMember.findFirst({
      where: { id: membershipId, tenantId },
    })
    if (!membership) throw new NotFoundError('Membership')

    return db.tenantMember.update({
      where: { id: membershipId },
      data: { active },
    })
  }

  static async countActiveMembers(tenantId: string) {
    return db.tenantMember.count({
      where: { tenantId, active: true },
    })
  }
}
