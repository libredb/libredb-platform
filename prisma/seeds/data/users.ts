export interface SeedUser {
  email: string
  name: string
  memberships: {
    tenantSlug: string
    roleCode: string
    isDefault: boolean
  }[]
}

export const PLATFORM_USERS: SeedUser[] = [
  {
    email: 'admin@libredb.example',
    name: 'Platform Admin',
    memberships: [],
  },
  {
    email: 'devops@libredb.example',
    name: 'Platform DevOps',
    memberships: [],
  },
]

export const TENANT_USERS: SeedUser[] = [
  // Acme Corp (8 users)
  {
    email: 'sarah.chen@acme.com',
    name: 'Sarah Chen',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_ADMIN', isDefault: true },
      { tenantSlug: 'startup-labs', roleCode: 'TENANT_VIEWER', isDefault: false },
    ],
  },
  {
    email: 'james.wilson@acme.com',
    name: 'James Wilson',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_EDITOR', isDefault: true },
    ],
  },
  {
    email: 'maria.garcia@acme.com',
    name: 'Maria Garcia',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_EDITOR', isDefault: true },
    ],
  },
  {
    email: 'alex.kumar@acme.com',
    name: 'Alex Kumar',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_EDITOR', isDefault: true },
    ],
  },
  {
    email: 'emily.park@acme.com',
    name: 'Emily Park',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_VIEWER', isDefault: true },
    ],
  },
  {
    email: 'david.jones@acme.com',
    name: 'David Jones',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_VIEWER', isDefault: true },
    ],
  },
  {
    email: 'lisa.zhang@acme.com',
    name: 'Lisa Zhang',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_VIEWER', isDefault: true },
    ],
  },
  {
    email: 'mike.brown@acme.com',
    name: 'Mike Brown',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_VIEWER', isDefault: true },
    ],
  },
  // Startup Labs (3 users)
  {
    email: 'tom.reed@startuplabs.io',
    name: 'Tom Reed',
    memberships: [
      { tenantSlug: 'startup-labs', roleCode: 'TENANT_ADMIN', isDefault: true },
    ],
  },
  {
    email: 'anna.white@startuplabs.io',
    name: 'Anna White',
    memberships: [
      { tenantSlug: 'startup-labs', roleCode: 'TENANT_EDITOR', isDefault: true },
    ],
  },
  {
    email: 'jake.lee@startuplabs.io',
    name: 'Jake Lee',
    memberships: [
      { tenantSlug: 'startup-labs', roleCode: 'TENANT_VIEWER', isDefault: true },
    ],
  },
  // Solo Developer (1 user)
  {
    email: 'dev@example.com',
    name: 'Solo Dev',
    memberships: [
      { tenantSlug: 'solo-developer', roleCode: 'TENANT_ADMIN', isDefault: true },
    ],
  },
]

export const ALL_USERS = [...PLATFORM_USERS, ...TENANT_USERS]
