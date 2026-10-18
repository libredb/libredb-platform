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
    email: 'sarah.chen@acme.test',
    name: 'Sarah Chen',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_ADMIN', isDefault: true },
      { tenantSlug: 'startup-labs', roleCode: 'TENANT_VIEWER', isDefault: false },
    ],
  },
  {
    email: 'james.wilson@acme.test',
    name: 'James Wilson',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_EDITOR', isDefault: true },
    ],
  },
  {
    email: 'maria.garcia@acme.test',
    name: 'Maria Garcia',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_EDITOR', isDefault: true },
    ],
  },
  {
    email: 'alex.kumar@acme.test',
    name: 'Alex Kumar',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_EDITOR', isDefault: true },
    ],
  },
  {
    email: 'emily.park@acme.test',
    name: 'Emily Park',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_VIEWER', isDefault: true },
    ],
  },
  {
    email: 'david.jones@acme.test',
    name: 'David Jones',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_VIEWER', isDefault: true },
    ],
  },
  {
    email: 'lisa.zhang@acme.test',
    name: 'Lisa Zhang',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_VIEWER', isDefault: true },
    ],
  },
  {
    email: 'mike.brown@acme.test',
    name: 'Mike Brown',
    memberships: [
      { tenantSlug: 'acme-corp', roleCode: 'TENANT_VIEWER', isDefault: true },
    ],
  },
  // Startup Labs (3 users)
  {
    email: 'tom.reed@startuplabs.test',
    name: 'Tom Reed',
    memberships: [
      { tenantSlug: 'startup-labs', roleCode: 'TENANT_ADMIN', isDefault: true },
    ],
  },
  {
    email: 'anna.white@startuplabs.test',
    name: 'Anna White',
    memberships: [
      { tenantSlug: 'startup-labs', roleCode: 'TENANT_EDITOR', isDefault: true },
    ],
  },
  {
    email: 'jake.lee@startuplabs.test',
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
