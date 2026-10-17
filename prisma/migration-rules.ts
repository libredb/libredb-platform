// Rules for Prisma migrations that touch schema bridge.
// prisma/migration-rules.test.ts runs checkBridgeMigration over every migration, so `npm test` fails on a violation.

export interface MigrationViolation {
  migration: string
  rule: 'lock-timeout-first' | 'regrant-dropped-view'
  message: string
}

interface Statement {
  // The statement text without comments and without its terminating semicolon, trimmed.
  text: string
  terminated: boolean
}

// Splits SQL into statements at top-level semicolons and removes comments.
// Single-quoted strings, quoted identifiers and dollar-quoted bodies are kept intact, so a semicolon or a comment marker inside them does not split.
function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = []
  let current = ''
  let i = 0

  const push = (terminated: boolean) => {
    const text = current.trim()
    if (text !== '') statements.push({ text, terminated })
    current = ''
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      current += ' '
      continue
    }

    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      if (depth > 0) throw new Error('unterminated block comment')
      current += ' '
      continue
    }

    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      if (j >= sql.length) throw new Error(`unterminated ${ch === "'" ? 'string literal' : 'quoted identifier'}`)
      current += sql.slice(i, j + 1)
      i = j + 1
      continue
    }

    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
        const end = sql.indexOf(tag[0], i + tag[0].length)
        if (end === -1) throw new Error(`unterminated dollar-quoted body ${tag[0]}`)
        current += sql.slice(i, end + tag[0].length)
        i = end + tag[0].length
        continue
      }
    }

    if (ch === ';') {
      push(true)
      i++
      continue
    }

    current += ch
    i++
  }
  push(false)
  return statements
}

// Removes string literals and dollar-quoted bodies, so a mention inside a value does not count as a reference.
function withoutLiterals(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "''").replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, '$$$$')
}

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`
const QUALIFIED_NAME = String.raw`${IDENTIFIER}\s*\.\s*${IDENTIFIER}`

function normalizeIdentifier(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1).replace(/""/g, '"') : identifier.toLowerCase()
}

// Returns schema.name for a qualified name, or null for an unqualified one.
function normalizeName(name: string): string | null {
  const match = new RegExp(String.raw`^(${IDENTIFIER})\s*\.\s*(${IDENTIFIER})$`).exec(name.trim())
  if (!match) return null
  return `${normalizeIdentifier(match[1])}.${normalizeIdentifier(match[2])}`
}

function splitNameList(list: string): string[] {
  return list.match(new RegExp(String.raw`${QUALIFIED_NAME}|${IDENTIFIER}`, 'g')) ?? []
}

// An unquoted or quoted identifier bridge that is not itself the second part of a qualified name.
const BRIDGE_REFERENCE = /(?<![\w$."])(?:bridge|"bridge")(?![\w$"])/i

function mentionsBridge(statements: Statement[]): boolean {
  return statements.some((statement) => BRIDGE_REFERENCE.test(withoutLiterals(statement.text)))
}

const LOCK_TIMEOUT = /^SET\s+lock_timeout\s*=\s*'5s'$/i
const DROP_VIEW = /^DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$/i
const CREATE_VIEW = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:RECURSIVE\s+)?VIEW\s+(${QUALIFIED_NAME})`, 'i')
const GRANT_ON_ALL_TABLES = new RegExp(String.raw`^GRANT\s+[\s\S]+?\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+([\s\S]+?)\s+TO\s+`, 'i')
const GRANT_ON = /^GRANT\s+[\s\S]+?\s+ON\s+(?:TABLE\s+)?([\s\S]+?)\s+TO\s+/i

export function checkBridgeMigration(name: string, sql: string): MigrationViolation[] {
  const statements = splitStatements(sql)
  if (!mentionsBridge(statements)) return []

  const violations: MigrationViolation[] = []

  const first = statements[0]
  if (!first || !first.terminated || !LOCK_TIMEOUT.test(first.text)) {
    violations.push({
      migration: name,
      rule: 'lock-timeout-first',
      message: `${name}: a migration that touches schema bridge must start with SET lock_timeout = '5s'; so it cannot queue Studio's reads behind a long lock`,
    })
  }

  // For each bridge view dropped in this file: whether it was re-created, and whether a GRANT on it followed the latest re-creation.
  const dropped = new Map<string, { recreated: boolean; granted: boolean }>()

  for (const statement of statements) {
    const text = withoutLiterals(statement.text)

    const drop = DROP_VIEW.exec(text)
    if (drop) {
      for (const view of splitNameList(drop[1]).map(normalizeName)) {
        if (view?.startsWith('bridge.')) dropped.set(view, { recreated: false, granted: false })
      }
      continue
    }

    const create = CREATE_VIEW.exec(text)
    if (create) {
      const view = normalizeName(create[1])
      const state = view ? dropped.get(view) : undefined
      if (state) {
        state.recreated = true
        state.granted = false
      }
      continue
    }

    const grantAll = GRANT_ON_ALL_TABLES.exec(text)
    if (grantAll) {
      const schemas = splitNameList(grantAll[1]).map(normalizeIdentifier)
      if (schemas.includes('bridge')) {
        for (const state of dropped.values()) {
          if (state.recreated) state.granted = true
        }
      }
      continue
    }

    const grant = GRANT_ON.exec(text)
    if (grant) {
      for (const view of splitNameList(grant[1]).map(normalizeName)) {
        const state = view ? dropped.get(view) : undefined
        if (state?.recreated) state.granted = true
      }
    }
  }

  for (const [view, state] of dropped) {
    if (state.recreated && !state.granted) {
      violations.push({
        migration: name,
        rule: 'regrant-dropped-view',
        message: `${name}: drops and re-creates view ${view} without a GRANT on ${view} after the CREATE VIEW in the same file; DROP VIEW loses the view's grants`,
      })
    }
  }

  return violations
}
