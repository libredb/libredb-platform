import { describe, expect, it } from 'vitest'
import { ALL_USERS } from './users'

// The names that RFC 2606 reserves for tests and documentation, which nobody can register: the top-level domains test,
// example, invalid and localhost, and the second-level domains example.com, example.net and example.org.
const RESERVED_TOP_LEVEL = ['test', 'example', 'invalid', 'localhost']
const RESERVED_SECOND_LEVEL = ['example.com', 'example.net', 'example.org']

function onReservedDomain(email: string): boolean {
  const labels = email.slice(email.lastIndexOf('@') + 1).toLowerCase().split('.')
  return RESERVED_TOP_LEVEL.includes(labels.at(-1) ?? '') || RESERVED_SECOND_LEVEL.includes(labels.slice(-2).join('.'))
}

describe('the users of the development seed', () => {
  it('live on reserved domains, so no seeded address belongs to a real organization', () => {
    expect(ALL_USERS.length).toBeGreaterThan(0)
    expect(ALL_USERS.map((user) => user.email).filter((email) => !onReservedDomain(email))).toEqual([])
  })
})
