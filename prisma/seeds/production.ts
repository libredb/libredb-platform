// prisma/seeds/production.ts
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { PERMISSIONS, SYSTEM_ROLES, ROLE_PERMISSIONS } from '../../src/shared/lib/permissions'
import { ConfigError } from '../../src/shared/lib/errors'
import { parseDeploymentMode } from '../../src/shared/lib/deployment'
import { normalizeEmail } from '../../src/shared/lib/identity/authorize-credentials'
import { ACHIEVEMENTS } from '../../src/features/gamification/lib/achievement-definitions'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

// The creator of the platform-wide support tags when no platform admin exists; support_tags.createdByUserId has no foreign key.
const SYSTEM_CREATOR = 'system'

// The one tenant of a self-hosted install; getInstallTenant() reads it back.
const INSTALL_TENANT_SLUG = 'default'

// The updatedBy of a Studio setting the seed writes; an admin's change records the admin's users.id instead.
const SEED_SETTINGS_AUTHOR = 'system:seed'

interface BootstrapAdmin {
  email: string
  password: string
}

/**
 * The first platform admin of a cloud install, from BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD.
 * Returns null when neither is set, because no default password exists, and throws ConfigError when only one is set.
 * An empty value counts as unset, and no message repeats a value.
 */
function readBootstrapAdmin(env: NodeJS.ProcessEnv): BootstrapAdmin | null {
  const email = env.BOOTSTRAP_ADMIN_EMAIL || undefined
  const password = env.BOOTSTRAP_ADMIN_PASSWORD || undefined
  if (!email && !password) return null
  if (!email || !password) {
    const missing = email ? 'BOOTSTRAP_ADMIN_PASSWORD' : 'BOOTSTRAP_ADMIN_EMAIL'
    throw new ConfigError(`BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together, and ${missing} is not set`)
  }

  // The same rules as a registration, so the admin can sign in through the login form.
  const normalizedEmail = normalizeEmail(email)
  if (!z.string().email().safeParse(normalizedEmail).success) {
    throw new ConfigError('BOOTSTRAP_ADMIN_EMAIL must be an email address')
  }
  if (password.length < 8) {
    throw new ConfigError('BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters')
  }
  return { email: normalizedEmail, password }
}

/**
 * Creates the bootstrap admin once: the user, its password credential, a default membership of the platform tenant and
 * the PLATFORM_ADMIN role, in one transaction. A later run finds the credential and changes nothing, so the seed never
 * overwrites a password hash or undoes a change made in the app. Returns the admin's user id.
 */
/** The install tenant's name from PLATFORM_ORGANIZATION_NAME, required in self-hosted mode; an empty value counts as unset. */
function readOrganizationName(env: NodeJS.ProcessEnv): string {
  const name = env.PLATFORM_ORGANIZATION_NAME?.trim()
  if (!name) throw new ConfigError('PLATFORM_ORGANIZATION_NAME is required in self-hosted mode')
  return name
}

/**
 * A self-hosted install has exactly one tenant, so the seed refuses a database that holds any other,
 * such as one seeded in cloud mode before.
 */
async function assertNoOtherTenant(): Promise<void> {
  const other = await db.tenant.count({ where: { slug: { not: INSTALL_TENANT_SLUG } } })
  if (other > 0) {
    throw new ConfigError(
      `self-hosted mode needs a database whose only tenant is "${INSTALL_TENANT_SLUG}", and ${other} other tenant(s) exist`,
    )
  }
}

async function seedBootstrapAdmin(admin: BootstrapAdmin, platformTenantId: string): Promise<string> {
  const existing = await db.passwordCredential.findUnique({
    where: { email: admin.email },
    select: { userId: true },
  })
  if (existing) {
    console.log('  ✓ Platform admin exists, left unchanged')
    return existing.userId
  }

  const platformAdminRole = await db.role.findFirst({
    where: { code: SYSTEM_ROLES.PLATFORM_ADMIN, tenantId: null, isSystem: true },
  })
  if (!platformAdminRole) throw new Error('The PLATFORM_ADMIN system role is missing')

  const passwordHash = await bcrypt.hash(admin.password, 12)
  const adminUser = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: admin.email,
        name: 'Platform Admin',
        active: true,
        emailVerified: true,
        passwordCredential: { create: { email: admin.email, passwordHash } },
      },
    })
    const membership = await tx.tenantMember.create({
      data: { tenantId: platformTenantId, userId: user.id, isDefault: true, active: true },
    })
    await tx.userRole.create({
      data: { membershipId: membership.id, roleId: platformAdminRole.id },
    })
    return user
  })
  console.log('  ✓ Platform admin user + membership')
  return adminUser.id
}

export async function seedProduction() {
  console.log('🌱 Seeding production data...')

  // Read and checked before the first write, so a misconfigured seed changes nothing.
  const selfHosted = parseDeploymentMode(process.env.DEPLOYMENT_MODE) === 'self-hosted'
  // Self-hosted creates no user: the first admin is the Keycloak user the installer creates.
  const bootstrapAdmin = selfHosted ? null : readBootstrapAdmin(process.env)
  const organizationName = selfHosted ? readOrganizationName(process.env) : null
  if (selfHosted) await assertNoOtherTenant()

  // 1. Plan Configs
  // No plan carries a price: an admin sets prices in cloud mode, and a later seed run keeps them.
  const plans = [
    { code: 'FREE', name: 'Free', isDefault: true, sortOrder: 0, maxUsers: 1, maxConnections: 3, queryHistoryDays: 7 },
    { code: 'TEAM', name: 'Team', isDefault: false, sortOrder: 1, maxUsers: 10, maxConnections: 10, queryHistoryDays: 30, featureSharedQueries: true, featureAuditLog: true },
    { code: 'BUSINESS', name: 'Business', isDefault: false, sortOrder: 2, maxUsers: -1, maxConnections: -1, queryHistoryDays: -1, featureSharedQueries: true, featureAdvancedRbac: true, featureAuditLog: true, featurePerfTracking: true, featureDataMasking: true, featureSamlSso: true, featureApiAccess: true },
    { code: 'ENTERPRISE', name: 'Enterprise', isDefault: false, sortOrder: 3, maxUsers: -1, maxConnections: -1, queryHistoryDays: -1, featureSharedQueries: true, featureAdvancedRbac: true, featureAuditLog: true, featurePerfTracking: true, featureDataMasking: true, featureSamlSso: true, featureScimProvisioning: true, featureSelfHosted: true, featureApiAccess: true },
  ]

  for (const plan of plans) {
    await db.planConfig.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan,
    })
  }
  console.log('  ✓ Plan configs')

  // 2. Permissions
  for (const [, code] of Object.entries(PERMISSIONS)) {
    const category = code.split('.')[0]
    await db.permission.upsert({
      where: { code },
      update: { name: code, category },
      create: { code, name: code, category },
    })
  }
  console.log('  ✓ Permissions')

  // 3. System Roles (tenantId is null for system roles)
  for (const [, code] of Object.entries(SYSTEM_ROLES)) {
    // Prisma @@unique([tenantId, code]): for system roles tenantId is null
    // We can't use upsert with a compound unique that has null, so use findFirst + create/update
    const existing = await db.role.findFirst({ where: { code, tenantId: null, isSystem: true } })
    if (existing) {
      await db.role.update({ where: { id: existing.id }, data: { name: code, isSystem: true } })
    } else {
      await db.role.create({ data: { code, name: code, isSystem: true } })
    }
  }
  console.log('  ✓ System roles')

  // 4. Role-Permission assignments
  for (const [roleCode, permCodes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await db.role.findFirst({ where: { code: roleCode, isSystem: true } })
    if (!role) continue

    for (const permCode of permCodes) {
      const perm = await db.permission.findUnique({ where: { code: permCode } })
      if (!perm) continue

      // Use findFirst to check existence, then create if not exists
      const existing = await db.rolePermission.findFirst({
        where: { roleId: role.id, permissionId: perm.id },
      })
      if (!existing) {
        await db.rolePermission.create({
          data: { roleId: role.id, permissionId: perm.id },
        })
      }
    }
  }
  console.log('  ✓ Role-permission assignments')

  // 5. The tenants: one install tenant in self-hosted mode, or the "LibreDB Platform" system tenant for platform admins
  // and the bootstrap admin in cloud mode
  const enterprisePlan = await db.planConfig.findUniqueOrThrow({ where: { code: 'ENTERPRISE' } })
  let adminUserId: string | null = null
  if (organizationName !== null) {
    // Created once and never renamed: a later run leaves the name an admin may have changed in the app.
    await db.tenant.upsert({
      where: { slug: INSTALL_TENANT_SLUG },
      update: {},
      create: {
        name: organizationName,
        slug: INSTALL_TENANT_SLUG,
        active: true,
        planConfigId: enterprisePlan.id,
      },
    })
    console.log('  ✓ Install tenant')

    // The governance default for statement capture is redacted, which keeps statements searchable by table and column
    // without their literals (Studio's GOVERNANCE.md). It is inserted once, and a later run never overwrites a value an
    // admin set. The validation trigger checks the value against the allowlist.
    await db.studioSetting.createMany({
      data: [{ key: 'queryLog.statementCapture', value: 'redacted', updatedBy: SEED_SETTINGS_AUTHOR }],
      skipDuplicates: true,
    })
    console.log('  ✓ Studio settings')
  } else {
    const platformTenant = await db.tenant.upsert({
      where: { slug: 'libredb-platform' },
      update: {},
      create: {
        name: 'LibreDB Platform',
        slug: 'libredb-platform',
        active: true,
        planConfigId: enterprisePlan.id,
      },
    })
    console.log('  ✓ Platform tenant')

    if (bootstrapAdmin) {
      adminUserId = await seedBootstrapAdmin(bootstrapAdmin, platformTenant.id)
    } else {
      console.log('  - No platform admin: BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are not set')
    }
  }

  // 6. Reference Types & Values
  const refData = [
    {
      type: { code: 'TICKET_PRIORITY', name: 'Ticket Priority', category: 'SUPPORT', isSystem: true },
      values: [
        { code: 'LOW', name: 'Low', sortOrder: 0, colorCode: '#6b7280' },
        { code: 'MEDIUM', name: 'Medium', sortOrder: 1, colorCode: '#f59e0b' },
        { code: 'HIGH', name: 'High', sortOrder: 2, colorCode: '#ef4444' },
        { code: 'URGENT', name: 'Urgent', sortOrder: 3, colorCode: '#dc2626' },
      ],
    },
    {
      type: { code: 'TICKET_CATEGORY', name: 'Ticket Category', category: 'SUPPORT', isSystem: true },
      values: [
        { code: 'GENERAL', name: 'General', sortOrder: 0 },
        { code: 'BILLING', name: 'Billing', sortOrder: 1 },
        { code: 'TECHNICAL', name: 'Technical', sortOrder: 2 },
      ],
    },
    {
      type: { code: 'TICKET_STATUS', name: 'Ticket Status', category: 'SUPPORT', isSystem: true },
      values: [
        { code: 'OPEN', name: 'Open', sortOrder: 0, colorCode: '#3b82f6' },
        { code: 'IN_PROGRESS', name: 'In Progress', sortOrder: 1, colorCode: '#f59e0b' },
        { code: 'RESOLVED', name: 'Resolved', sortOrder: 2, colorCode: '#22c55e' },
        { code: 'CLOSED', name: 'Closed', sortOrder: 3, colorCode: '#6b7280' },
      ],
    },
    {
      type: { code: 'DATABASE_ENVIRONMENT', name: 'Database Environment', category: 'GOVERNANCE', isSystem: true },
      values: [
        { code: 'PRODUCTION', name: 'Production', sortOrder: 0, colorCode: '#ef4444' },
        { code: 'STAGING', name: 'Staging', sortOrder: 1, colorCode: '#f59e0b' },
        { code: 'DEVELOPMENT', name: 'Development', sortOrder: 2, colorCode: '#22c55e' },
        { code: 'TEST', name: 'Test', sortOrder: 3, colorCode: '#6b7280' },
      ],
    },
    {
      type: { code: 'NOTIFICATION_TYPE', name: 'Notification Type', category: 'PLATFORM', isSystem: true },
      values: [
        { code: 'INFO', name: 'Info', sortOrder: 0, colorCode: '#3b82f6', icon: 'info' },
        { code: 'WARNING', name: 'Warning', sortOrder: 1, colorCode: '#f59e0b', icon: 'alert-triangle' },
        { code: 'ERROR', name: 'Error', sortOrder: 2, colorCode: '#ef4444', icon: 'alert-circle' },
        { code: 'SUCCESS', name: 'Success', sortOrder: 3, colorCode: '#22c55e', icon: 'check-circle' },
      ],
    },
  ]

  for (const { type, values } of refData) {
    const refType = await db.referenceType.upsert({
      where: { code: type.code },
      update: type,
      create: type,
    })
    for (const value of values) {
      await db.referenceValue.upsert({
        where: { code: value.code },
        update: { ...value, referenceTypeId: refType.id },
        create: { ...value, referenceTypeId: refType.id },
      })
    }
  }
  console.log('  ✓ Reference types & values')

  // 7. Menus
  // STUDIO has no stored URL: getAuthorizedMenus resolves it from STUDIO_PUBLIC_URL at request time.
  const menus = [
    { code: 'STUDIO', name: 'Studio', url: null, icon: 'square-arrow-out-up-right', sortOrder: 0, level: 0 },
    { code: 'CONNECTIONS', name: 'Connections', url: '/connections', icon: 'database', sortOrder: 1, level: 0 },
    { code: 'TEAM', name: 'Team', url: '/team', icon: 'users', sortOrder: 2, level: 0 },
    { code: 'AUDIT', name: 'Audit Log', url: '/audit', icon: 'scroll-text', sortOrder: 3, level: 0 },
    { code: 'BILLING', name: 'Billing', url: '/billing', icon: 'credit-card', sortOrder: 4, level: 0 },
    { code: 'SUPPORT', name: 'Support', url: '/support', icon: 'life-buoy', sortOrder: 5, level: 0 },
    { code: 'SETTINGS', name: 'Settings', url: '/settings', icon: 'settings', sortOrder: 6, level: 0 },
    // Self-hosted only: SELF_HOSTED_ONLY_MENU_CODES hides them in cloud mode.
    { code: 'STUDIO_SETTINGS', name: 'Studio Settings', url: '/studio-settings', icon: 'sliders-horizontal', sortOrder: 7, level: 0 },
    { code: 'STUDIO_USERS', name: 'Studio Users', url: '/studio-users', icon: 'users-round', sortOrder: 8, level: 0 },
    { code: 'ADMIN', name: 'Admin', url: '/admin', icon: 'shield', sortOrder: 10, level: 0 },
    { code: 'ADMIN_DASHBOARD', name: 'Dashboard', url: '/admin/dashboard', icon: 'layout-dashboard', sortOrder: 0, level: 1 },
    { code: 'ADMIN_TENANTS', name: 'Tenants', url: '/admin/tenants', icon: 'building-2', sortOrder: 1, level: 1 },
    { code: 'ADMIN_USERS', name: 'Users', url: '/admin/users', icon: 'users', sortOrder: 2, level: 1 },
    { code: 'ADMIN_PLANS', name: 'Plans', url: '/admin/plans', icon: 'tag', sortOrder: 3, level: 1 },
    { code: 'ADMIN_REFDATA', name: 'Reference Data', url: '/admin/reference-data', icon: 'list', sortOrder: 4, level: 1 },
    { code: 'ADMIN_MENUS', name: 'Menus', url: '/admin/menus', icon: 'menu', sortOrder: 5, level: 1 },
    // Self-hosted only, as licensing is: SELF_HOSTED_ONLY_MENU_CODES hides it in cloud mode.
    { code: 'ADMIN_LICENSE', name: 'License', url: '/admin/license', icon: 'key-round', sortOrder: 6, level: 1 },
  ]

  // The embedded workspace is gone; deleting its menu cascades to its menu_roles rows.
  await db.menu.deleteMany({ where: { code: 'WORKSPACE' } })

  // First pass: create all menus without parent
  for (const menu of menus) {
    await db.menu.upsert({
      where: { code: menu.code },
      update: { name: menu.name, url: menu.url, icon: menu.icon, sortOrder: menu.sortOrder, level: menu.level },
      create: { code: menu.code, name: menu.name, url: menu.url, icon: menu.icon, sortOrder: menu.sortOrder, level: menu.level },
    })
  }

  // Second pass: set parent for admin sub-menus
  const adminMenu = await db.menu.findUnique({ where: { code: 'ADMIN' } })
  if (adminMenu) {
    const adminChildren = ['ADMIN_DASHBOARD', 'ADMIN_TENANTS', 'ADMIN_USERS', 'ADMIN_PLANS', 'ADMIN_REFDATA', 'ADMIN_MENUS', 'ADMIN_LICENSE']
    for (const childCode of adminChildren) {
      await db.menu.update({
        where: { code: childCode },
        data: { parentId: adminMenu.id },
      })
    }
  }
  console.log('  ✓ Menus')

  // 8. Menu-Role assignments
  const menuRoleMap: Record<string, string[]> = {
    STUDIO: ['TENANT_ADMIN', 'TENANT_EDITOR', 'TENANT_VIEWER'],
    CONNECTIONS: ['TENANT_ADMIN'],
    TEAM: ['TENANT_ADMIN'],
    AUDIT: ['TENANT_ADMIN'],
    BILLING: ['TENANT_ADMIN'],
    SUPPORT: ['TENANT_ADMIN', 'TENANT_EDITOR', 'TENANT_VIEWER'],
    SETTINGS: ['TENANT_ADMIN'],
    STUDIO_SETTINGS: ['PLATFORM_ADMIN'],
    STUDIO_USERS: ['PLATFORM_ADMIN'],
    ADMIN: ['PLATFORM_ADMIN', 'PLATFORM_TECH'],
    ADMIN_DASHBOARD: ['PLATFORM_ADMIN', 'PLATFORM_TECH'],
    ADMIN_TENANTS: ['PLATFORM_ADMIN'],
    ADMIN_USERS: ['PLATFORM_ADMIN'],
    ADMIN_PLANS: ['PLATFORM_ADMIN'],
    ADMIN_REFDATA: ['PLATFORM_ADMIN'],
    ADMIN_MENUS: ['PLATFORM_ADMIN'],
    ADMIN_LICENSE: ['PLATFORM_ADMIN'],
  }

  for (const [menuCode, roleCodes] of Object.entries(menuRoleMap)) {
    const menu = await db.menu.findUnique({ where: { code: menuCode } })
    if (!menu) continue

    for (const roleCode of roleCodes) {
      const role = await db.role.findFirst({ where: { code: roleCode, isSystem: true } })
      if (!role) continue

      const existing = await db.menuRole.findFirst({
        where: { menuId: menu.id, roleId: role.id },
      })
      if (!existing) {
        await db.menuRole.create({
          data: { menuId: menu.id, roleId: role.id },
        })
      }
    }
  }
  console.log('  ✓ Menu-role assignments')

  // 9. Achievement Definitions
  for (let i = 0; i < ACHIEVEMENTS.length; i++) {
    const a = ACHIEVEMENTS[i]
    await db.achievement.upsert({
      where: { code: a.code },
      update: { name: a.name, description: a.description, icon: a.icon, category: a.category, threshold: a.threshold, xp: a.xp, sortOrder: i },
      create: { code: a.code, name: a.name, description: a.description, icon: a.icon, category: a.category, threshold: a.threshold, xp: a.xp, sortOrder: i },
    })
  }
  console.log('  ✓ Achievement definitions')

  // 10. Platform-wide support tags (tenantId = null)
  const platformTags = [
    { name: 'bug',             colorCode: '#ef4444', description: 'Defects and regressions' },
    { name: 'billing',         colorCode: '#10b981', description: 'Invoice, subscription, payment' },
    { name: 'question',        colorCode: '#3b82f6', description: 'How-to and usage questions' },
    { name: 'feature-request', colorCode: '#8b5cf6', description: 'New feature suggestions' },
    { name: 'infra',           colorCode: '#f59e0b', description: 'Platform infrastructure issues' },
    { name: 'security',        colorCode: '#dc2626', description: 'Security-related reports' },
  ]

  // The bootstrap admin creates the platform-wide tags, or SYSTEM_CREATOR when no admin exists
  for (const tag of platformTags) {
    const existing = await db.supportTag.findFirst({
      where: { tenantId: null, name: tag.name },
    })
    if (existing) {
      await db.supportTag.update({
        where: { id: existing.id },
        data: { colorCode: tag.colorCode, description: tag.description },
      })
    } else {
      await db.supportTag.create({
        data: { ...tag, tenantId: null, createdByUserId: adminUserId ?? SYSTEM_CREATOR },
      })
    }
  }
  console.log('  ✓ Platform-wide support tags')

  console.log('✅ Production seed complete')
}
