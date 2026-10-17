// The closed and open vocabularies of query events (Studio's GOVERNANCE.md).
// This module has no server dependency, so client components import it; src/shared/lib/bridge/query-events.ts reads the events.

export const QUERY_EVENT_STATEMENT_TYPES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DDL', 'OTHER'] as const
export const QUERY_EVENT_STATUSES = ['success', 'error', 'cancelled', 'refused'] as const
export const QUERY_EVENT_CAPTURES = ['none', 'redacted', 'full'] as const

/** The sources that Studio's GOVERNANCE.md names. The vocabulary is open, so a filter accepts any value of the contract's format and a page renders an unknown one verbatim. */
export const QUERY_EVENT_SOURCES = [
  'editor',
  'multi-query',
  'transaction',
  'object-edit',
  'maintenance',
  'profile',
  'key-scan',
  'agent',
  'agent-handover',
  'mcp',
] as const

export type QueryEventStatus = (typeof QUERY_EVENT_STATUSES)[number]
export type QueryEventCapture = (typeof QUERY_EVENT_CAPTURES)[number]
