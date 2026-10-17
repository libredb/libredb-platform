import { describe, it, expect } from 'vitest'
import { buildTsQuery } from './support-search'

describe('buildTsQuery', () => {
  it('joins tokens with & and prefix-matches', () => {
    expect(buildTsQuery('connection timeout')).toBe('connection:* & timeout:*')
  })
  it('collapses whitespace', () => {
    expect(buildTsQuery('  foo   bar  ')).toBe('foo:* & bar:*')
  })
  it('escapes single quotes', () => {
    expect(buildTsQuery("it's broken")).toBe('its:* & broken:*')
  })
  it('returns null for empty input', () => {
    expect(buildTsQuery('')).toBeNull()
    expect(buildTsQuery('   ')).toBeNull()
  })
  it('strips tsquery operators from raw input', () => {
    expect(buildTsQuery('foo & bar | baz ! qux')).toBe('foo:* & bar:* & baz:* & qux:*')
  })
  it('caps length to 10 tokens', () => {
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')
    const q = buildTsQuery(many)!
    expect(q.split('&').length).toBe(10)
  })
})
