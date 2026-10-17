// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Docker Compose names a project after its directory unless the file names one, and two files of one project that
// declare a service of the same name share that service's container. database-compose.yml, the development database,
// names no project, so docker-compose.test.yml names its own: otherwise `npm run test:db`, which force-recreates the
// test postgres service, recreates the development database container instead, and a test `down -v` removes it.

const ROOT = path.join(__dirname, '..', '..')

/** The top-level `name:` of a compose file, or undefined when the file leaves the project to its directory. */
function projectName(file: string): string | undefined {
  return /^name:\s*(\S+)\s*$/m.exec(readFileSync(path.join(ROOT, file), 'utf8'))?.[1]
}

describe('compose projects', () => {
  it('docker-compose.test.yml names a project of its own, never the development database project', () => {
    const devProject = projectName('database-compose.yml') ?? path.basename(ROOT)
    const testProject = projectName('docker-compose.test.yml')

    expect(testProject).toBeDefined()
    expect(testProject).not.toBe(devProject)
  })
})
