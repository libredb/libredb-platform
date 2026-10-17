import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Platform seals credentials and never opens them, so a compromised Platform cannot read one: no code under src may
// decipher, and no module may export a function that opens, decrypts or unseals.

const repoRoot = path.resolve(__dirname, '../../../..')
// Assembled from parts so that a repository-wide search for the decipher call does not match this test.
const DECIPHER = ['create', 'Decipheriv'].join('')
const FORBIDDEN_EXPORTS: ReadonlySet<string> = new Set(['open', 'decrypt', 'unseal'])
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? listFiles(full) : [full]
  })
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.[jt]sx$/.test(fileName)) return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX
  return /\.[mc]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  )
}

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name)))
}

// The names a module exports: declarations marked export, export lists, namespace re-exports and a default
// export of a named binding.
function exportedNames(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKind(fileName))
  return source.statements.flatMap((statement): string[] => {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (!clause) return []
      return ts.isNamedExports(clause) ? clause.elements.map((element) => element.name.text) : [clause.name.text]
    }
    if (ts.isExportAssignment(statement)) {
      return ts.isIdentifier(statement.expression) ? [statement.expression.text] : []
    }
    if (!isExported(statement)) return []
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) => boundNames(declaration.name))
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      return [statement.name.text]
    }
    return []
  })
}

function forbiddenExports(fileName: string, text: string): string[] {
  return exportedNames(fileName, text).filter((name) => FORBIDDEN_EXPORTS.has(name))
}

describe('Platform never decrypts', () => {
  it(`no file under src calls ${DECIPHER} or exports an open, decrypt or unseal function`, () => {
    const files = listFiles(path.join(repoRoot, 'src')).filter((file) => SOURCE_FILE.test(file))
    expect(files.length).toBeGreaterThan(100)

    const offences = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      const where = path.relative(repoRoot, file)
      return [
        ...(text.includes(DECIPHER) ? [`${where} calls ${DECIPHER}`] : []),
        ...forbiddenExports(file, text).map((name) => `${where} exports ${name}`),
      ]
    })
    expect(offences).toEqual([])
  })

  it('recognises each way a module can export a forbidden name, and nothing else', () => {
    const forbidden = [
      'export function decrypt(text: string) { return text }',
      'export async function open() {}',
      'export default function unseal() {}',
      'export const decrypt = (text: string) => text',
      'export let open = () => null',
      'export const { unseal } = helpers',
      'export const [decrypt] = helpers',
      'function decrypt() {}\nexport { decrypt }',
      'function reveal() {}\nexport { reveal as open }',
      "export { unseal } from './x'",
      "export * as decrypt from './x'",
      'function open() {}\nexport default open',
      'export class unseal {}',
    ]
    for (const sample of forbidden) {
      expect(forbiddenExports('sample.ts', sample), sample).not.toEqual([])
    }
    expect(forbiddenExports('sample.js', 'export function decrypt() {}')).toEqual(['decrypt'])

    const allowed = [
      'export function openDialog() {}',
      'function decrypt() {}',
      'export const sealing = { decrypt: 1 }',
      'export function seal({ open }: { open: boolean }) { return open }',
      "export * from './x'",
    ]
    for (const sample of allowed) {
      expect(forbiddenExports('sample.tsx', sample), sample).toEqual([])
    }
  })
})
