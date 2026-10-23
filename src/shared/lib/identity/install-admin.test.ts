import { describe, expect, it, vi } from 'vitest'

const admitKeycloakAdmin = vi.hoisted(() => vi.fn())
const db = vi.hoisted(() => ({ marker: 'db' }))
const getInstallTenant = vi.hoisted(() => vi.fn())
const getKeycloakDirectory = vi.hoisted(() => vi.fn())
const getLicenseStatus = vi.hoisted(() => vi.fn())

vi.mock('../db', () => ({ db }))
vi.mock('../runtime-config', () => ({ getRuntimeConfig: () => ({ PLATFORM_ADMIN_ROLE: 'platform-admin' }) }))
vi.mock('../keycloak/directory', () => ({ getKeycloakDirectory }))
vi.mock('../license/install-license', () => ({ getLicenseStatus }))
vi.mock('./install-tenant', () => ({ getInstallTenant }))
vi.mock('./keycloak-provisioning', () => ({ admitKeycloakAdmin }))

import { LicenseLimitError } from '../errors'
import { admitInstallAdmin } from './install-admin'

const IDENTITY = { sub: 'kc-alice', sid: null, email: 'alice@libredb.test', name: 'Alice', username: 'alice', roles: ['admin'] }

describe('admitInstallAdmin', () => {
  it('admits through admitKeycloakAdmin with the license, the install tenant, the directory and PLATFORM_ADMIN_ROLE of this install', async () => {
    admitKeycloakAdmin.mockResolvedValue(undefined)

    await admitInstallAdmin(IDENTITY)

    expect(admitKeycloakAdmin).toHaveBeenCalledWith(db, IDENTITY, {
      getLicenseStatus,
      getInstallTenant,
      directory: getKeycloakDirectory,
      adminRole: 'platform-admin',
    })
  })

  it('passes on the LicenseLimitError of a refused seat', async () => {
    admitKeycloakAdmin.mockRejectedValue(new LicenseLimitError('LICENSE_ADMIN_SEATS'))

    await expect(admitInstallAdmin(IDENTITY)).rejects.toMatchObject({ code: 'LICENSE_ADMIN_SEATS' })
  })
})
