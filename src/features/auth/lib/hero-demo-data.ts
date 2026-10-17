// Static, decorative demo data for the login hero. Non-prod, never persisted.
// The topology intentionally models a SINGLE tenant's internal structure:
// roles on the left, governance in the middle, the tenant's own connections
// on the right. It must not imply cross-tenant data mixing.

export type TenantRole = 'admin' | 'editor' | 'viewer'

export type ConnectionEngine =
  | 'postgres'
  | 'mysql'
  | 'oracle'
  | 'mssql'
  | 'sqlite'
  | 'mongodb'
  | 'redis'

export type ConnectionStatus = 'healthy' | 'warning' | 'slow'

export interface DemoRole {
  /** Display label shown in the roles column, e.g. "Admin". */
  name: string
  /** Stable key for React keys and testing. */
  key: TenantRole
  /** Short access description, e.g. "Full access", "Read-only". */
  access: string
}

export interface DemoConnection {
  name: string
  engine: ConnectionEngine
  status: ConnectionStatus
}

export interface SupportedEngine {
  engine: ConnectionEngine
  /** Full display label, e.g. "PostgreSQL". */
  label: string
  /** 2-letter chip text, e.g. "PG". */
  chip: string
  /** Brand hex color, used inline on chip backgrounds. Brand identity, not a design token. */
  color: string
}

export const demoRoles: ReadonlyArray<DemoRole> = [
  { name: 'Admin',  key: 'admin',  access: 'Full access' },
  { name: 'Editor', key: 'editor', access: 'Read + write' },
  { name: 'Viewer', key: 'viewer', access: 'Read only' },
] as const

export const demoConnections: ReadonlyArray<DemoConnection> = [
  { name: 'prod-pg',    engine: 'postgres', status: 'healthy' },
  { name: 'staging',    engine: 'mysql',    status: 'healthy' },
  { name: 'analytics',  engine: 'mongodb',  status: 'healthy' },
  { name: 'oracle-erp', engine: 'oracle',   status: 'slow'    },
] as const

/**
 * All database engines that LibreDB Studio, the separate query editor product, supports.
 * Used by the "supported engines" strip on the login hero.
 * Order is deliberate: most-used / highest-perceived-weight first.
 */
export const supportedEngines: ReadonlyArray<SupportedEngine> = [
  { engine: 'postgres', label: 'PostgreSQL', chip: 'PG', color: '#336791' },
  { engine: 'mysql',    label: 'MySQL',      chip: 'My', color: '#4479A1' },
  { engine: 'oracle',   label: 'Oracle',     chip: 'Or', color: '#C74634' },
  { engine: 'mssql',    label: 'SQL Server', chip: 'MS', color: '#A6192E' },
  { engine: 'sqlite',   label: 'SQLite',     chip: 'SL', color: '#003B57' },
  { engine: 'mongodb',  label: 'MongoDB',    chip: 'Mo', color: '#4DB33D' },
  { engine: 'redis',    label: 'Redis',      chip: 'Rd', color: '#A41E11' },
] as const

/** 2-letter engine chip. Derived from `supportedEngines` for consistency. */
export function engineChip(engine: ConnectionEngine): string {
  const found = supportedEngines.find((e) => e.engine === engine)
  return found?.chip ?? '??'
}
