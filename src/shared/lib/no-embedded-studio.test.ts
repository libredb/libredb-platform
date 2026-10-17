import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

const repoRoot = path.resolve(__dirname, '../../..')
// Assembled from parts so that a repository-wide search for the package name
// does not match this test.
const PACKAGE = ['@libredb', 'studio'].join('/')

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? listFiles(full) : [full]
  })
}

function relative(file: string): string {
  return path.relative(repoRoot, file)
}

describe('no embedded Studio', () => {
  it(`package.json, package-lock.json, next.config.ts, src/app/globals.css and .github contain no ${PACKAGE} reference, and no file under src imports or requires it`, () => {
    const configFiles = ['package.json', 'package-lock.json', 'next.config.ts', 'src/app/globals.css']
      .map((file) => path.join(repoRoot, file))
    const githubFiles = listFiles(path.join(repoRoot, '.github'))

    const mentions = [...configFiles, ...githubFiles]
      .filter((file) => readFileSync(file, 'utf8').includes(PACKAGE))
      .map(relative)
    expect(mentions).toEqual([])

    const importPattern = new RegExp(`(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)['"]${PACKAGE}(?:/[^'"]*)?['"]`)
    const importers = listFiles(path.join(repoRoot, 'src'))
      .filter((file) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file))
      .filter((file) => importPattern.test(readFileSync(file, 'utf8')))
      .map(relative)
    expect(importers).toEqual([])
  })

  it(`no file under src mentions ${PACKAGE}`, () => {
    const mentions = listFiles(path.join(repoRoot, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes(PACKAGE))
      .map(relative)
    expect(mentions).toEqual([])
  })
})
