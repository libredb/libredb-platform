import type { EngineId } from '../../../src/features/connections/lib/engines'
import type { CredentialSet } from '../../../src/shared/lib/sealing/lsb1'

/**
 * A development connection as Platform stores it: an engine, a definition of non-secret fields, and the
 * credential set of each access level, which the seed seals to the development seal key and never stores in plaintext.
 * The hosts are fictional except the local platform database, so Studio lists the connections without reaching them.
 */
export interface SeedConnection {
  tenantSlug: string
  name: string
  engine: EngineId
  environment: 'production' | 'staging' | 'development' | 'local' | 'other'
  definition: Record<string, unknown>
  readCredential: CredentialSet
  writeCredential?: CredentialSet
  createdByEmail: string
}

export const CONNECTIONS: SeedConnection[] = [
  // Acme Corp (5 connections)
  {
    tenantSlug: 'acme-corp',
    name: 'Acme Production PG',
    engine: 'postgres',
    environment: 'production',
    definition: { host: 'pg-prod.acme.internal', port: 5432, database: 'acme_production', ssl: { mode: 'verify-full' } },
    readCredential: { user: 'acme_readonly', password: 'seed_password' },
    writeCredential: { user: 'acme_writer', password: 'seed_password' },
    createdByEmail: 'sarah.chen@acme.com',
  },
  {
    tenantSlug: 'acme-corp',
    name: 'Acme Staging PG',
    engine: 'postgres',
    environment: 'staging',
    definition: { host: 'pg-staging.acme.internal', port: 5432, database: 'acme_staging' },
    readCredential: { user: 'acme_dev', password: 'seed_password' },
    writeCredential: { user: 'acme_dev_writer', password: 'seed_password' },
    createdByEmail: 'sarah.chen@acme.com',
  },
  {
    tenantSlug: 'acme-corp',
    name: 'Acme Analytics MySQL',
    engine: 'mysql',
    environment: 'production',
    definition: { host: 'mysql-analytics.acme.internal', port: 3306, database: 'acme_analytics', ssl: { mode: 'require' } },
    readCredential: { user: 'analytics_reader', password: 'seed_password' },
    createdByEmail: 'sarah.chen@acme.com',
  },
  {
    tenantSlug: 'acme-corp',
    name: 'Acme Cache Redis',
    engine: 'redis',
    environment: 'production',
    definition: { host: 'redis.acme.internal', port: 6379, database: '0' },
    readCredential: { user: 'default', password: 'seed_password' },
    createdByEmail: 'sarah.chen@acme.com',
  },
  {
    tenantSlug: 'acme-corp',
    name: 'Acme Docs MongoDB',
    engine: 'mongodb',
    environment: 'production',
    definition: {
      host: 'mongo.acme.internal',
      port: 27017,
      database: 'acme_docs',
      authSource: 'admin',
      ssl: { mode: 'verify-full' },
    },
    readCredential: { user: 'doc_reader', password: 'seed_password' },
    createdByEmail: 'sarah.chen@acme.com',
  },
  // Startup Labs (2 connections)
  {
    tenantSlug: 'startup-labs',
    name: 'Startup Main PG',
    engine: 'postgres',
    environment: 'production',
    definition: { host: 'db.startuplabs.io', port: 5432, database: 'startup_main', ssl: { mode: 'require' } },
    readCredential: { user: 'startup_app', password: 'seed_password' },
    writeCredential: { user: 'startup_app_writer', password: 'seed_password' },
    createdByEmail: 'tom.reed@startuplabs.io',
  },
  {
    tenantSlug: 'startup-labs',
    name: 'Startup Dev MySQL',
    engine: 'mysql',
    environment: 'development',
    definition: { host: 'dev-mysql.startuplabs.io', port: 3306, database: 'startup_dev' },
    readCredential: { user: 'dev_user', password: 'seed_password' },
    createdByEmail: 'tom.reed@startuplabs.io',
  },
  // Solo Developer (1 connection)
  {
    tenantSlug: 'solo-developer',
    name: 'Local Dev PG',
    engine: 'postgres',
    environment: 'local',
    definition: { host: 'localhost', port: 5432, database: 'myapp_dev' },
    readCredential: { user: 'postgres', password: 'seed_password' },
    createdByEmail: 'dev@example.com',
  },
  // Acme Corp: the database of database-compose.yml, which a development Studio can reach.
  {
    tenantSlug: 'acme-corp',
    name: 'Local Platform DB',
    engine: 'postgres',
    environment: 'local',
    definition: { host: 'localhost', port: 5432, database: 'libredb' },
    readCredential: { user: 'libredb_platform', password: 'libredb_platform_dev' },
    createdByEmail: 'sarah.chen@acme.com',
  },
]
