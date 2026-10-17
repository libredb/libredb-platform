import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'fs'
import path from 'path'
import { checkBridgeMigration } from './migration-rules'

const migrationsDir = path.resolve(__dirname, 'migrations')

const compliant = `
-- Bridge views for contract v1.
/* The lock timeout must come first. */
SET lock_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS bridge;

DROP VIEW IF EXISTS bridge.grants_v1;
CREATE VIEW bridge.grants_v1 AS SELECT 1 AS level;
GRANT SELECT ON bridge.grants_v1 TO libredb_studio, libredb_platform;

CREATE OR REPLACE VIEW bridge.settings_v1 AS SELECT 'x;y' AS key;
`

describe('checkBridgeMigration', () => {
  it("flags a bridge migration that does not start with SET lock_timeout = '5s'", () => {
    const missing = checkBridgeMigration('20261015000000_missing', 'CREATE SCHEMA bridge;\n')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ migration: '20261015000000_missing', rule: 'lock-timeout-first' })

    const late = checkBridgeMigration(
      '20261015000001_late',
      "-- comment\nCREATE SCHEMA bridge;\nSET lock_timeout = '5s';\n",
    )
    expect(late.map((v) => v.rule)).toEqual(['lock-timeout-first'])

    const otherValue = checkBridgeMigration(
      '20261015000002_value',
      "SET lock_timeout = '60s';\nCREATE VIEW \"bridge\".\"contract\" AS SELECT 1;\n",
    )
    expect(otherValue.map((v) => v.rule)).toEqual(['lock-timeout-first'])

    const quoted = checkBridgeMigration(
      '20261015000003_quoted',
      'GRANT USAGE ON SCHEMA "bridge" TO libredb_studio;\n',
    )
    expect(quoted.map((v) => v.rule)).toEqual(['lock-timeout-first'])
  })

  it('flags DROP VIEW bridge.grants_v1 without a GRANT on bridge.grants_v1 in the same file', () => {
    const noGrant = checkBridgeMigration(
      '20261015000004_regrant',
      `SET lock_timeout = '5s';
DROP VIEW bridge.grants_v1;
CREATE VIEW bridge.grants_v1 AS SELECT 2 AS level;
GRANT SELECT ON bridge.connections_v1 TO libredb_studio;
`,
    )
    expect(noGrant).toHaveLength(1)
    expect(noGrant[0]).toMatchObject({ migration: '20261015000004_regrant', rule: 'regrant-dropped-view' })
    expect(noGrant[0].message).toContain('bridge.grants_v1')

    const grantBeforeCreate = checkBridgeMigration(
      '20261015000005_order',
      `SET lock_timeout = '5s';
GRANT SELECT ON bridge.grants_v1 TO libredb_studio;
DROP VIEW IF EXISTS "bridge"."grants_v1" CASCADE;
CREATE VIEW bridge.grants_v1 AS SELECT 2 AS level;
`,
    )
    expect(grantBeforeCreate.map((v) => v.rule)).toEqual(['regrant-dropped-view'])

    const grantInComment = checkBridgeMigration(
      '20261015000006_comment',
      `SET lock_timeout = '5s';
DROP VIEW bridge.grants_v1;
CREATE VIEW bridge.grants_v1 AS SELECT 2 AS level;
-- GRANT SELECT ON bridge.grants_v1 TO libredb_studio;
`,
    )
    expect(grantInComment.map((v) => v.rule)).toEqual(['regrant-dropped-view'])
  })

  it('accepts a compliant bridge migration and ignores migrations that do not touch bridge', () => {
    expect(checkBridgeMigration('20261015000007_compliant', compliant)).toEqual([])

    const listAndSchemaGrant = `-- leading comment
set   lock_timeout='5s';
DROP VIEW bridge.grants_v1, bridge.settings_v1;
CREATE VIEW bridge.grants_v1 AS SELECT 1;
CREATE VIEW bridge.settings_v1 AS SELECT 1;
GRANT SELECT ON TABLE bridge.grants_v1, "bridge"."settings_v1" TO libredb_studio;
`
    expect(checkBridgeMigration('20261015000008_list', listAndSchemaGrant)).toEqual([])

    const allTables = `SET lock_timeout = '5s';
DROP VIEW bridge.grants_v1;
CREATE VIEW bridge.grants_v1 AS SELECT 1;
GRANT SELECT ON ALL TABLES IN SCHEMA bridge TO libredb_platform;
`
    expect(checkBridgeMigration('20261015000009_all', allTables)).toEqual([])

    const platformOnly = `-- The bridge is not touched here.
CREATE TABLE "platform"."bridge_audit" ("id" TEXT NOT NULL);
INSERT INTO platform.note (text) VALUES ('bridge.grants_v1 is a view');
DROP VIEW platform.report;
CREATE VIEW platform.report AS SELECT 1;
`
    expect(checkBridgeMigration('20261015000010_platform', platformOnly)).toEqual([])
  })

  it('every migration under prisma/migrations complies', () => {
    const migrations = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    expect(migrations.length).toBeGreaterThan(0)

    const violations = migrations.flatMap((name) => {
      const file = path.join(migrationsDir, name, 'migration.sql')
      expect(existsSync(file), `${name} has no migration.sql`).toBe(true)
      return checkBridgeMigration(name, readFileSync(file, 'utf8'))
    })
    expect(violations).toEqual([])
  })
})
