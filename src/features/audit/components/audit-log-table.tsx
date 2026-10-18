'use client'

import { useState, useCallback } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Alert, AlertDescription } from '@/shared/components/ui/alert'
import { Search, ChevronLeft, ChevronRight, DatabaseIcon, CalendarIcon, AlertCircleIcon } from 'lucide-react'
import { StatCard } from '@/shared/components/composed/stat-card'
import {
  QUERY_EVENT_SOURCES,
  QUERY_EVENT_STATEMENT_TYPES,
  QUERY_EVENT_STATUSES,
} from '@/shared/lib/bridge/query-event-vocabulary'
import type { QueryEvent } from '@/shared/lib/bridge/query-events'

/** A query event as the page and GET /api/db/audit send it, with its time as an ISO string. */
export type AuditEventRow = Pick<
  QueryEvent,
  | 'eventId'
  | 'subject'
  | 'username'
  | 'connectionId'
  | 'connectionKnown'
  | 'connectionName'
  | 'engine'
  | 'source'
  | 'statementType'
  | 'statementCapture'
  | 'statement'
  | 'statementTruncated'
  | 'rowCount'
  | 'durationMs'
  | 'status'
  | 'errorMessage'
  | 'transactionOutcome'
> & { startedAt: string }

interface AuditLogTableProps {
  initialEvents: AuditEventRow[]
  initialTotal: number
  subjects: { subject: string; username: string | null }[]
  connections: { id: string; name: string; engine: string }[]
  stats: { total: number; today: number; errors: number }
}

const STATUS_VARIANTS: Record<AuditEventRow['status'], 'success' | 'destructive' | 'warning' | 'secondary'> = {
  success: 'success',
  error: 'destructive',
  refused: 'warning',
  cancelled: 'secondary',
}

const PAGE_SIZE = 50

function DurationCell({ ms }: { ms: number | null }) {
  if (ms == null) return <span className="text-muted-foreground">-</span>
  const colorClass =
    ms < 100
      ? 'text-emerald-500 dark:text-emerald-400'
      : ms < 1000
        ? 'text-amber-500 dark:text-amber-400'
        : 'text-red-500 dark:text-red-400'
  return <span className={`tabular-nums ${colorClass}`}>{ms}ms</span>
}

export function AuditLogTable({
  initialEvents,
  initialTotal,
  subjects,
  connections,
  stats,
}: AuditLogTableProps) {
  const [events, setEvents] = useState<AuditEventRow[]>(initialEvents)
  const [total, setTotal] = useState(initialTotal)
  const [offset, setOffset] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Filters
  const [search, setSearch] = useState('')
  const [filterSubject, setFilterSubject] = useState('')
  const [filterConnection, setFilterConnection] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')

  const fetchEvents = useCallback(
    async (newOffset: number = 0) => {
      setIsLoading(true)
      try {
        const params = new URLSearchParams()
        if (search) params.set('search', search)
        if (filterSubject) params.set('subject', filterSubject)
        if (filterConnection) params.set('connectionId', filterConnection)
        if (filterSource) params.set('source', filterSource)
        if (filterType) params.set('statementType', filterType)
        if (filterStatus) params.set('status', filterStatus)
        // The date inputs hold local days; the range covers the whole of both days.
        if (filterFrom) params.set('from', new Date(`${filterFrom}T00:00:00`).toISOString())
        if (filterTo) params.set('to', new Date(`${filterTo}T23:59:59.999`).toISOString())
        params.set('offset', String(newOffset))
        params.set('limit', String(PAGE_SIZE))

        const res = await fetch(`/api/db/audit?${params.toString()}`)
        const data = await res.json().catch(() => null)
        if (!res.ok) {
          throw new Error(data?.error ?? `The audit log request failed with status ${res.status}`)
        }
        setEvents(data.events)
        setTotal(data.total)
        setOffset(newOffset)
        setFetchError(null)
      } catch (error) {
        // The rows already shown stay, and the banner says they are not the result of the new filters.
        setFetchError(error instanceof Error ? error.message : String(error))
      } finally {
        setIsLoading(false)
      }
    },
    [search, filterSubject, filterConnection, filterSource, filterType, filterStatus, filterFrom, filterTo],
  )

  const handleSearch = () => {
    fetchEvents(0)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr)
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  // A select's items give its trigger the name of the chosen value instead of the subject or the id.
  const subjectItems = [
    { value: '', label: 'All Users' },
    ...subjects.map((s) => ({ value: s.subject, label: s.username ?? s.subject })),
  ]
  const connectionItems = [
    { value: '', label: 'All Connections' },
    ...connections.map((c) => ({ value: c.id, label: c.name })),
  ]

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          title="Total Queries"
          value={stats.total.toLocaleString()}
          icon={DatabaseIcon}
        />
        <StatCard
          title="Today"
          value={stats.today.toLocaleString()}
          icon={CalendarIcon}
        />
        <StatCard
          title="Errors"
          value={stats.errors.toLocaleString()}
          icon={AlertCircleIcon}
        />
      </div>

      {/* Filters: toolbar area */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search statements..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <Select items={subjectItems} value={filterSubject} onValueChange={(val) => setFilterSubject(val ?? '')}>
          <SelectTrigger>
            <SelectValue placeholder="All Users" />
          </SelectTrigger>
          <SelectContent>
            {subjectItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select items={connectionItems} value={filterConnection} onValueChange={(val) => setFilterConnection(val ?? '')}>
          <SelectTrigger>
            <SelectValue placeholder="All Connections" />
          </SelectTrigger>
          <SelectContent>
            {connectionItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterSource} onValueChange={(val) => setFilterSource(val ?? '')}>
          <SelectTrigger>
            <SelectValue placeholder="All Sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Sources</SelectItem>
            {QUERY_EVENT_SOURCES.map((source) => (
              <SelectItem key={source} value={source}>
                {source}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterType} onValueChange={(val) => setFilterType(val ?? '')}>
          <SelectTrigger>
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Types</SelectItem>
            {QUERY_EVENT_STATEMENT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterStatus} onValueChange={(val) => setFilterStatus(val ?? '')}>
          <SelectTrigger>
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Statuses</SelectItem>
            {QUERY_EVENT_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          aria-label="From"
          className="w-auto"
          value={filterFrom}
          onChange={(e) => setFilterFrom(e.target.value)}
        />
        <Input
          type="date"
          aria-label="To"
          className="w-auto"
          value={filterTo}
          onChange={(e) => setFilterTo(e.target.value)}
        />

        <Button size="sm" variant="outline" onClick={handleSearch} disabled={isLoading}>
          Filter
        </Button>
      </div>

      {fetchError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>Could not load the audit log: {fetchError}</AlertDescription>
        </Alert>
      )}

      {/* Table */}
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Connection</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="max-w-[300px]">Statement</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No query events found.
                </TableCell>
              </TableRow>
            ) : (
              events.map((event) => (
                <TableRow key={event.eventId}>
                  <TableCell className="text-xs tabular-nums">
                    {formatDate(event.startedAt)}
                  </TableCell>
                  <TableCell className="text-sm">
                    <span title={event.subject}>{event.username ?? event.subject}</span>
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className={event.connectionKnown ? undefined : 'italic text-muted-foreground'} title={event.connectionId}>
                      {event.connectionName}
                    </span>
                    {event.engine && (
                      <span className="ml-1 text-xs text-muted-foreground">({event.engine})</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{event.source}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{event.statementType}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[300px]">
                    {event.statementCapture === 'none' ? (
                      <span className="text-xs italic text-muted-foreground">not captured</span>
                    ) : event.statement === null ? (
                      <span className="text-muted-foreground">-</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto p-0 text-left font-mono text-xs truncate max-w-xs hover:text-primary"
                        onClick={() =>
                          setExpandedId(expandedId === event.eventId ? null : event.eventId)
                        }
                      >
                        {expandedId === event.eventId || event.statement.length <= 100
                          ? event.statement
                          : `${event.statement.substring(0, 100)}...`}
                      </Button>
                    )}
                    {event.errorMessage && (
                      <div className="mt-1 text-xs text-destructive">{event.errorMessage}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {event.rowCount ?? '-'}
                  </TableCell>
                  <TableCell className="text-xs">
                    <DurationCell ms={event.durationMs} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[event.status] ?? 'secondary'}>{event.status}</Badge>
                    {event.transactionOutcome && (
                      <span className="ml-1 text-xs text-muted-foreground">{event.transactionOutcome}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Showing {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => fetchEvents(offset - PAGE_SIZE)}
              disabled={offset === 0 || isLoading}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm tabular-nums">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fetchEvents(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || isLoading}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
