import { expect } from 'vitest'

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

// Asserts that the operation fails with the given PostgreSQL SQLSTATE code,
// for example '42501' (insufficient_privilege).
export async function expectSqlState(operation: Promise<unknown> | (() => Promise<unknown>), sqlState: string): Promise<void> {
  const promise = typeof operation === 'function' ? operation() : operation
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  if (caught === undefined) {
    expect.fail(`expected SQLSTATE ${sqlState}, but the operation succeeded`)
  }
  const actual = sqlStateOf(caught)
  if (actual !== sqlState) {
    const message = caught instanceof Error ? caught.message : String(caught)
    expect.fail(`expected SQLSTATE ${sqlState}, got ${actual ?? 'none'}: ${message}`)
  }
}
