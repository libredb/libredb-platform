// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(__dirname, '..', '..')
const PINNED = ['prisma', '@prisma/client', '@prisma/adapter-pg', 'pg', 'bcryptjs']

function readJson(file: string) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** The version npm installed at the root, which the server, the seed and the tests run with. */
function rootInstalledVersion(name: string): string {
  return readJson(path.join(ROOT, 'node_modules', name, 'package.json')).version
}

describe('docker/migrator', () => {
  it('the migrator pins equal the root installed versions of prisma, @prisma/client, @prisma/adapter-pg, pg and bcryptjs', () => {
    const manifest = readJson(path.join(__dirname, 'package.json'))
    const lock = readJson(path.join(__dirname, 'package-lock.json'))

    expect(Object.keys(manifest.dependencies).sort()).toEqual([...PINNED].sort())
    for (const name of PINNED) {
      const root = rootInstalledVersion(name)
      expect(manifest.dependencies[name], name).toBe(root)
      expect(lock.packages[''].dependencies[name], name).toBe(root)
      expect(lock.packages[`node_modules/${name}`].version, name).toBe(root)
    }
  })

  // A Prisma release moves files of its CLI and client, so the list of the files the image deletes from them names the
  // version it was checked against, and a bump of the pins revisits it.
  it('prisma-cli-prune.txt was checked against the pinned version of prisma and @prisma/client', () => {
    const manifest = readJson(path.join(__dirname, 'package.json'))
    const list = readFileSync(path.join(__dirname, 'prisma-cli-prune.txt'), 'utf8')
    const checked = [...list.matchAll(/^version (\S+)$/gm)].map(match => match[1])

    expect(checked).toHaveLength(1)
    for (const name of ['prisma', '@prisma/client']) {
      expect(manifest.dependencies[name], `${name}: revisit every line of prisma-cli-prune.txt`).toBe(checked[0])
    }
  })
})
