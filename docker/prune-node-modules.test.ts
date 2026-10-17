// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const PRUNE = path.join(__dirname, 'prune-node-modules.sh')

let dir: string
let tree: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'prune-node-modules-'))
  tree = path.join(dir, 'node_modules')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Creates each file, a path relative to the tree, with its directories. */
function writeTree(files: string[]) {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
    writeFileSync(path.join(tree, file), '')
  }
}

/** The paths, relative to the tree, that it still holds. */
function remaining(paths: string[]): string[] {
  return paths.filter(file => existsSync(path.join(tree, file)))
}

/** Runs the prune on the tree, with --prisma-cli and a list of the given content when there is one. */
function prune(list?: string) {
  const options: string[] = []
  if (list !== undefined) {
    writeFileSync(path.join(dir, 'list.txt'), list)
    options.push('--prisma-cli', path.join(dir, 'list.txt'))
  }
  const result = spawnSync('/bin/sh', [PRUNE, ...options, tree], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr }
}

describe('docker/prune-node-modules.sh', () => {
  it('removes the test-utils directories at any depth of a package, but keeps one that holds its own package.json', () => {
    const helpers = ['@prisma/get-platform/dist/test-utils/vitestContext.js', 'lib/src/deep/test-utils/index.js']
    // A package named test-utils, at the top of the tree or below another package, and a subpackage such as
    // preact/test-utils hold their own package.json.
    const kept = ['@prisma/get-platform/package.json', '@prisma/get-platform/dist/index.js', 'lib/package.json',
      'test-utils/package.json', 'test-utils/index.js', 'lib/node_modules/test-utils/package.json',
      'lib/node_modules/test-utils/index.js', 'preact/package.json', 'preact/test-utils/package.json',
      'preact/test-utils/dist/testUtils.js']
    writeTree([...helpers, ...kept])

    expect(prune()).toEqual({ status: 0, stderr: '' })
    expect(remaining(['@prisma/get-platform/dist/test-utils', 'lib/src/deep/test-utils'])).toEqual([])
    expect(remaining(kept)).toEqual(kept)
  })

  it('removes the test, docs and example directories whose parent holds a package.json, but no package of that name', () => {
    const removed = ['lib/test', 'lib/__tests__', 'lib/docs', 'lib/examples', 'preact/test-utils/test']
    // A scoped package named test, and a test directory whose parent is no package.
    const kept = ['lib/package.json', 'lib/src/test/index.js', '@playwright/test/package.json',
      '@playwright/test/index.js', 'preact/package.json', 'preact/test-utils/package.json']
    writeTree([...removed.map(directory => `${directory}/index.js`), ...kept])

    expect(prune()).toEqual({ status: 0, stderr: '' })
    expect(remaining(removed)).toEqual([])
    expect(remaining(kept)).toEqual(kept)
  })

  it('with --prisma-cli, deletes each path the list deletes, every match of a `*` included, and nothing else', () => {
    const deleted = ['react', '@prisma/studio-core/dist/ui', 'prisma/build/query_compiler_fast_bg.postgresql.wasm',
      'prisma/build/query_compiler_small_bg.postgresql.js']
    const kept = ['@prisma/studio-core/package.json', '@prisma/studio-core/dist/data/bff/index.cjs',
      'prisma/build/index.js', 'prisma/build/prisma_schema_build_bg.wasm']
    writeTree(['react/index.js', '@prisma/studio-core/dist/ui/index.js', ...deleted.slice(2), ...kept])

    const list = [
      '# The paths are relative to node_modules.',
      'version 7.5.0',
      '',
      'delete react',
      'delete @prisma/studio-core/dist/ui',
      'delete prisma/build/query_compiler_*',
      'keep @prisma/studio-core/dist/data/bff/index.cjs',
      'keep prisma/build/index.js',
      '',
    ].join('\n')
    expect(prune(list)).toEqual({ status: 0, stderr: '' })
    expect(remaining(deleted)).toEqual([])
    expect(remaining(kept)).toEqual(kept)
  })

  it('with --prisma-cli, reads the last line of a list that lacks its newline', () => {
    writeTree(['react/index.js', 'pg/index.js'])

    expect(prune('delete pg\ndelete react').status).toBe(0)
    expect(remaining(['react', 'pg'])).toEqual([])
  })

  it('with --prisma-cli, fails when a path the list deletes matches nothing, or a path it keeps is missing afterwards', () => {
    writeTree(['prisma/build/index.js'])

    for (const entry of ['prisma/build/schema_engine_bg.wasm', 'prisma/build/query_compiler_*']) {
      const { status, stderr } = prune(`delete ${entry}\n`)
      expect(status, entry).toBe(1)
      expect(stderr, entry).toContain(`holds no ${entry}, which ${path.join(dir, 'list.txt')} deletes`)
    }

    const { status, stderr } = prune('keep prisma/build/index.js\ndelete prisma/build\n')
    expect(status).toBe(1)
    expect(stderr).toContain('lacks prisma/build/index.js, which the image\'s commands load')
  })

  it('with --prisma-cli, fails on a line that is no version, delete or keep line with one value, and on a missing list', () => {
    writeTree(['react/index.js'])

    for (const line of ['remove react', 'delete', 'delete react react-dom', 'keep', 'version 7.5.0 7.6.0']) {
      const { status, stderr } = prune(`${line}\n`)
      expect(status, line).toBe(1)
      expect(stderr, line).toMatch(/has the unknown keyword remove|line without exactly one value/)
    }
    expect(remaining(['react/index.js'])).toEqual(['react/index.js'])

    const missing = spawnSync('/bin/sh', [PRUNE, '--prisma-cli', path.join(dir, 'absent.txt'), tree],
      { encoding: 'utf8' })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('does not exist')
  })
})
