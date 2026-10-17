import { DatabaseIcon } from 'lucide-react'
import { format } from 'date-fns'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { EmptyState } from '@/shared/components/composed/empty-state'

export interface ConnectionView {
  id: string
  name: string
  engine: string
  /** The address the definition points at, such as `db.internal:5432/orders`. */
  hostSummary: string
  active: boolean
  createdAt: string
}

export function TenantConnectionsTab({
  connections,
}: {
  connections: ConnectionView[]
}) {
  if (connections.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <EmptyState
          icon={DatabaseIcon}
          title="No connections"
          description="This tenant has no database connections yet."
        />
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Engine</TableHead>
            <TableHead>Host</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <span className="font-medium">{c.name}</span>
              </TableCell>
              <TableCell>
                <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                  {c.engine}
                </span>
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs text-muted-foreground">
                  {c.hostSummary}
                </span>
              </TableCell>
              <TableCell>
                {c.active ? (
                  <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500 dark:text-emerald-400">
                    <span className="inline-block size-1.5 rounded-full bg-current" />
                    Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <span className="inline-block size-1.5 rounded-full border border-current" />
                    Inactive
                  </span>
                )}
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {format(new Date(c.createdAt), 'MMM d, yyyy')}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
