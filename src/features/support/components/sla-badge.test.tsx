import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { SlaBadge } from './sla-badge'

// An URGENT ticket owes its first response within 1 hour and its resolution within 8 hours (support-sla.ts).
const NOW = new Date('2026-10-18T12:00:00.000Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3600_000).toISOString()

// The emoji and check mark the badge used to show, written as escapes.
const EMOJI = /[\u{1F534}\u{23F1}\u{2713}]/u

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

function renderBadge(ticket: { createdAt: string; firstResponseAt: string | null; resolvedAt: string | null }) {
  return render(<SlaBadge ticket={{ priority: 'URGENT', ...ticket }} />).container
}

describe('SlaBadge', () => {
  it.each([
    ['an overdue first response', { createdAt: hoursAgo(2), firstResponseAt: null, resolvedAt: null }, '1h 0m overdue · first response SLA'],
    ['a pending first response', { createdAt: hoursAgo(0.25), firstResponseAt: null, resolvedAt: null }, '45m · first response'],
    ['an overdue resolution', { createdAt: hoursAgo(10), firstResponseAt: hoursAgo(9), resolvedAt: null }, '2h 0m overdue · resolution SLA'],
    ['a pending resolution', { createdAt: hoursAgo(1), firstResponseAt: hoursAgo(0.5), resolvedAt: null }, '7h 0m · resolution'],
    ['a met SLA', { createdAt: hoursAgo(3), firstResponseAt: hoursAgo(2.5), resolvedAt: hoursAgo(1) }, 'SLA met'],
  ])('shows %s with a hidden icon and its text, without an emoji', (_state, ticket, text) => {
    const badge = renderBadge(ticket)

    expect(badge.textContent?.trim()).toBe(text)
    expect(badge.textContent).not.toMatch(EMOJI)
    expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
