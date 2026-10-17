// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ENTRYPOINT = path.join(__dirname, 'entrypoint.sh')
const APP_DIR = path.join(__dirname, '..')
const MIGRATOR_DIR = path.join(APP_DIR, 'docker', 'migrator')
const PRISMA = path.join(MIGRATOR_DIR, 'node_modules', 'prisma', 'build', 'index.js')
const PRISMA_CONFIG = path.join(MIGRATOR_DIR, 'prisma.config.mjs')

let stubDir: string
let callLog: string

/**
 * Puts a stub `node` first on PATH, so the entrypoint starts nothing real.
 * Each call appends its arguments and NEXT_MANUAL_SIG_HANDLE to the call log, and the call whose arguments contain
 * the text in FAIL_ON exits 3.
 */
beforeEach(() => {
  stubDir = mkdtempSync(path.join(tmpdir(), 'entrypoint-'))
  callLog = path.join(stubDir, 'calls.log')
  const stub = path.join(stubDir, 'node')
  writeFileSync(stub, [
    '#!/bin/sh',
    `printf '%s|%s\\n' "$*" "\${NEXT_MANUAL_SIG_HANDLE:-}" >> '${callLog}'`,
    'case "$*" in *"${FAIL_ON:-<none>}"*) exit 3 ;; esac',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(stub, 0o755)
})

afterEach(() => {
  rmSync(stubDir, { recursive: true, force: true })
})

function run(args: string[], env: Record<string, string> = {}) {
  rmSync(callLog, { force: true })
  const result = spawnSync('/bin/sh', [ENTRYPOINT, ...args], {
    encoding: 'utf8',
    env: { NODE_ENV: 'test', PATH: `${stubDir}:/usr/bin:/bin`, ...env },
  })
  const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : []
  return { status: result.status, stderr: result.stderr, calls }
}

describe('docker/entrypoint.sh', () => {
  it('an unknown subcommand prints the usage and exits 64', () => {
    for (const args of [['bogus'], ['serve', 'extra'], ['migrate-resolve'], ['migrate-resolve', '--rolled-back'], ['migrate-resolve', '--other', 'x']]) {
      const { status, stderr, calls } = run(args)
      expect(status, args.join(' ')).toBe(64)
      expect(stderr, args.join(' ')).toContain('Usage: entrypoint.sh [serve | migrate | maintain | migrate-status | migrate-resolve')
      expect(calls, args.join(' ')).toEqual([])
    }
  })

  it('serve exits non-zero before starting when MIGRATE_DATABASE_URL is set', () => {
    // Set but empty counts as well: the runtime never receives the owner URL.
    for (const value of ['x', '']) {
      for (const args of [[], ['serve']]) {
        const { status, stderr, calls } = run(args, { MIGRATE_DATABASE_URL: value })
        expect(status).not.toBe(0)
        expect(stderr).toContain('MIGRATE_DATABASE_URL')
        expect(calls).toEqual([])
      }
    }
  })

  it('serve, the default, runs node server.js with NEXT_MANUAL_SIG_HANDLE=true', () => {
    for (const args of [[], ['serve']]) {
      const { status, calls } = run(args)
      expect(status).toBe(0)
      expect(calls).toEqual(['server.js|true'])
    }
  })

  it('migrate runs the preflight, prisma migrate deploy with the pinned CLI and the bundled seed, in that order', () => {
    const { status, calls } = run(['migrate'])
    expect(status).toBe(0)
    expect(calls).toEqual([
      `${path.join(MIGRATOR_DIR, 'preflight.mjs')}|`,
      `${PRISMA} migrate deploy --config ${PRISMA_CONFIG}|`,
      `${path.join(MIGRATOR_DIR, 'dist', 'seed.cjs')}|`,
    ])
  })

  it('migrate stops at the first failing step with its exit code', () => {
    const preflight = run(['migrate'], { FAIL_ON: 'preflight.mjs' })
    expect(preflight.status).toBe(3)
    expect(preflight.calls).toHaveLength(1)

    const deploy = run(['migrate'], { FAIL_ON: 'migrate deploy' })
    expect(deploy.status).toBe(3)
    expect(deploy.calls).toHaveLength(2)
  })

  it('maintain, migrate-status and migrate-resolve run the bundled maintain and the pinned Prisma CLI', () => {
    expect(run(['maintain']).calls).toEqual([`${path.join(MIGRATOR_DIR, 'dist', 'maintain.cjs')}|`])
    expect(run(['migrate-status']).calls).toEqual([`${PRISMA} migrate status --config ${PRISMA_CONFIG}|`])
    expect(run(['migrate-resolve', '--rolled-back', '20261014_x']).calls)
      .toEqual([`${PRISMA} migrate resolve --rolled-back 20261014_x --config ${PRISMA_CONFIG}|`])
    expect(run(['migrate-resolve', '--applied', '20261014_x']).calls)
      .toEqual([`${PRISMA} migrate resolve --applied 20261014_x --config ${PRISMA_CONFIG}|`])
    // A failing Prisma call keeps its exit code, so a pending migration fails migrate-status.
    expect(run(['migrate-status'], { FAIL_ON: 'migrate status' }).status).toBe(3)
  })
})
