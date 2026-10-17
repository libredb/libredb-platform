'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PlusIcon, Trash2Icon, DatabaseIcon } from 'lucide-react'
import { type ColumnDef } from '@tanstack/react-table'
import { Button, buttonVariants } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { useAction } from '@/shared/hooks/use-action'
import { deleteDatabaseConnection } from '../actions/delete-database-connection'
import { ENGINES, isEngineId } from '../lib/engines'
import { PageHeader } from '@/shared/components/composed/page-header'
import { DataTable, SortableHeader } from '@/shared/components/composed/data-table'
import { EmptyState } from '@/shared/components/composed/empty-state'

/** A connection as the list shows it: never a credential or an envelope. */
export interface ConnectionListItem {
  id: string
  name: string
  engine: string
  /** The address the definition points at, such as `db.internal:5432/orders`. */
  hostSummary: string
  environment: string | null
  active: boolean
  hasWriteCredential: boolean
  createdAt: string
}

function engineLabel(engine: string): string {
  return isEngineId(engine) ? ENGINES[engine].label : engine
}

/** The id of the text that tells why New Connection is disabled. */
const CREATE_REFUSAL_ID = 'new-connection-refusal'

interface ConnectionListProps {
  connections: ConnectionListItem[]
  canCreate: boolean
  canDelete: boolean
  /**
   * The text the license of a self-hosted install would refuse a new connection with, which disables New Connection,
   * or null when the license allows one or does not apply.
   */
  createRefusal: string | null
}

export function ConnectionList({ connections, canCreate, canDelete, createRefusal }: ConnectionListProps) {
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const router = useRouter()

  const { execute: executeDelete, isPending: isDeleting } = useAction(
    deleteDatabaseConnection,
    {
      successMessage: 'Connection deleted successfully',
      onSuccess: () => {
        setDeleteDialogOpen(false)
        setDeleteId(null)
      },
    },
  )

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setDeleteId(id)
    setDeleteDialogOpen(true)
  }

  const confirmDelete = () => {
    if (deleteId) {
      executeDelete({ id: deleteId })
    }
  }

  const columns: ColumnDef<ConnectionListItem>[] = [
    {
      accessorKey: 'name',
      header: ({ column }) => <SortableHeader column={column}>Name</SortableHeader>,
      cell: ({ row }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
    },
    {
      accessorKey: 'engine',
      header: 'Engine',
      cell: ({ row }) => (
        <Badge variant="secondary">{engineLabel(row.original.engine)}</Badge>
      ),
    },
    {
      accessorKey: 'hostSummary',
      header: 'Host',
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">{row.original.hostSummary}</span>
      ),
    },
    {
      accessorKey: 'environment',
      header: 'Environment',
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.environment ?? ''}</span>
      ),
    },
    {
      id: 'access',
      header: 'Credentials',
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.hasWriteCredential ? 'Read and write' : 'Read only'}
        </span>
      ),
    },
    {
      accessorKey: 'active',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={row.original.active ? 'success' : 'destructive'}>
          {row.original.active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    ...(canDelete
      ? [
          {
            id: 'actions',
            header: () => null,
            cell: ({ row }: { row: { original: ConnectionListItem } }) => (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => handleDelete(e, row.original.id)}
              >
                <Trash2Icon className="size-4 text-destructive" />
              </Button>
            ),
            size: 48,
          } satisfies ColumnDef<ConnectionListItem>,
        ]
      : []),
  ]

  return (
    <div className="space-y-6">
      <PageHeader title="Connections" description="Manage your database connections">
        {canCreate && createRefusal === null && (
          <Link href="/connections/new" className={buttonVariants()}>
            <PlusIcon className="size-4" />
            New Connection
          </Link>
        )}
        {canCreate && createRefusal !== null && (
          <Button disabled aria-describedby={CREATE_REFUSAL_ID}>
            <PlusIcon className="size-4" />
            New Connection
          </Button>
        )}
      </PageHeader>

      {canCreate && createRefusal !== null && (
        <p id={CREATE_REFUSAL_ID} className="text-sm text-amber-600 dark:text-amber-400">
          {createRefusal}
        </p>
      )}

      <DataTable
        columns={columns}
        data={connections}
        globalSearch
        searchPlaceholder="Search connections..."
        onRowClick={(row) => router.push(`/connections/${row.id}`)}
        pageSize={20}
        emptyState={
          <EmptyState
            icon={DatabaseIcon}
            title="No connections yet"
            description="Create your first database connection to get started."
          />
        }
      />

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Connection</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this connection? Studio stops serving it, and its query
              events stay in the audit log.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
