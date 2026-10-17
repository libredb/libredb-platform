// The answers PostgreSQL gives to the statements of the seat gates in src/shared/lib/license/seats.ts and
// admin-seats.ts, and of the seat reads of user-seats.ts that the gates run, for unit tests that keep their tables in
// memory. bridge.grants_v1 publishes the unexpired grants of user subjects on the connections that are active and not
// deleted, as the migration that creates the view defines it, and `new Date()` stands for the database's now(). A
// statement the gates do not make throws, so a change to their SQL fails the unit tests until this module answers the
// new statement as PostgreSQL would; the database tests run the real statements.

type Row = Record<string, unknown>

/** The rows of the platform tables that the seat gates read. */
export interface SeatTables {
  readonly tenant: readonly Row[]
  readonly databaseConnection: readonly Row[]
  readonly connectionGrant: readonly Row[]
  /** The rows of platform.users, which only the admin seats read; none when left out. */
  readonly user?: readonly Row[]
}

/** The text of a tagged $queryRaw statement, its values as `?`, with whitespace collapsed and none inside parentheses. */
export function statementText(strings: readonly string[]): string {
  return strings.join('?').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()
}

function unexpired(grant: Row, now: Date): boolean {
  const expiresAt = grant.expiresAt as Date | null
  return expiresAt === null || expiresAt.getTime() > now.getTime()
}

/** The subjects bridge.grants_v1 publishes at `now`. */
function publishedSubjects(tables: SeatTables, now: Date): Set<string> {
  const subjects = new Set<string>()
  for (const grant of tables.connectionGrant) {
    const connection = tables.databaseConnection.find((row) => row.id === grant.connectionId)
    if (connection === undefined || connection.active !== true || connection.deletedAt !== null) continue
    if (grant.subjectKind === 'user' && unexpired(grant, now)) subjects.add(grant.subject as string)
  }
  return subjects
}

const LOCK_TENANT = 'SELECT id FROM platform.tenants WHERE id = ? FOR NO KEY UPDATE'
const SEAT_HOLDERS_AMONG = 'SELECT DISTINCT subject FROM bridge.grants_v1 WHERE subject = ANY(?::text[])'
const SEATS_IN_USE = 'SELECT count(DISTINCT subject)::integer AS "seatsInUse" FROM bridge.grants_v1'
const CONNECTION_STATE =
  'SELECT active FROM platform.database_connections WHERE id = ? AND "tenantId" = ? AND "deletedAt" IS NULL'
const SEATS_WITH_CONNECTION =
  'SELECT count(*)::integer AS "seatsInUse" FROM (SELECT subject FROM bridge.grants_v1 UNION ' +
  'SELECT subject FROM platform.connection_grants WHERE "connectionId" = ? AND "subjectKind" = \'user\' ' +
  'AND ("expiresAt" IS NULL OR "expiresAt" > now())) AS subjects'
const ADMIN_IDENTITIES =
  'SELECT id AS "userId", "keycloakId", email, name FROM platform.users WHERE "keycloakId" IS NOT NULL ORDER BY email, id'

// By email and then id, as PostgreSQL orders the plain lowercase ASCII text of the tests.
function byEmailThenId(left: Row, right: Row): number {
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return order(String(left.email), String(right.email)) || order(String(left.id), String(right.id))
}

/** The rows PostgreSQL returns for a statement of the seat gates over these tables; any other statement throws. */
export function answerSeatStatement(tables: SeatTables, strings: readonly string[], values: readonly unknown[]): Row[] {
  const now = new Date()
  const text = statementText(strings)
  switch (text) {
    case LOCK_TENANT:
      return tables.tenant.filter((row) => row.id === values[0]).map((row) => ({ id: row.id }))
    case SEAT_HOLDERS_AMONG: {
      const published = publishedSubjects(tables, now)
      const asked = new Set(values[0] as string[])
      return [...asked].filter((subject) => published.has(subject)).map((subject) => ({ subject }))
    }
    case SEATS_IN_USE:
      return [{ seatsInUse: publishedSubjects(tables, now).size }]
    case CONNECTION_STATE:
      return tables.databaseConnection
        .filter((row) => row.id === values[0] && row.tenantId === values[1] && row.deletedAt === null)
        .map((row) => ({ active: row.active }))
    case SEATS_WITH_CONNECTION: {
      const subjects = publishedSubjects(tables, now)
      for (const grant of tables.connectionGrant) {
        if (grant.connectionId === values[0] && grant.subjectKind === 'user' && unexpired(grant, now)) {
          subjects.add(grant.subject as string)
        }
      }
      return [{ seatsInUse: subjects.size }]
    }
    case ADMIN_IDENTITIES:
      return [...(tables.user ?? [])]
        .filter((row) => typeof row.keycloakId === 'string')
        .sort(byEmailThenId)
        .map((row) => ({ userId: row.id, keycloakId: row.keycloakId, email: row.email, name: row.name ?? null }))
    default:
      throw new Error(`tests/license/seat-statements.ts does not answer the statement: ${text}`)
  }
}

/** True for the text of the statement that locks the row of the install tenant. */
export function locksTenant(text: string): boolean {
  return text === LOCK_TENANT
}
