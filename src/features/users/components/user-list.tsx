'use client'

import { useState } from 'react'
import { UsersIcon, MoreHorizontalIcon, ShieldIcon, UserXIcon } from 'lucide-react'
import { type ColumnDef } from '@tanstack/react-table'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useAction } from '@/shared/hooks/use-action'
import { updateUserRole, toggleUserActive } from '../actions/update-user'
import { DataTable, SortableHeader } from '@/shared/components/composed/data-table'
import { EmptyState } from '@/shared/components/composed/empty-state'

interface RoleOption {
  id: string
  code: string
  name: string
}

interface MemberItem {
  id: string
  user: {
    id: string
    email: string
    name: string | null
    active: boolean
    lastLoginAt: string | null
  }
  roles: { role: RoleOption }[]
}

interface UserListProps {
  members: MemberItem[]
  roles: RoleOption[]
  canEdit: boolean
}

const ADMIN_ROLE_CODES = ['PLATFORM_ADMIN', 'TENANT_ADMIN', 'TENANT_OWNER']

export function UserList({ members, roles, canEdit }: UserListProps) {
  const [editingMember, setEditingMember] = useState<MemberItem | null>(null)
  const [selectedRoleId, setSelectedRoleId] = useState('')

  const { execute: executeUpdateRole, isPending: isUpdatingRole } = useAction(
    updateUserRole,
    {
      successMessage: 'Role updated successfully',
      onSuccess: () => setEditingMember(null),
    },
  )

  const { execute: executeToggleActive, isPending: isToggling } = useAction(
    toggleUserActive,
    { successMessage: 'User status updated' },
  )

  const handleEditRole = (member: MemberItem) => {
    setEditingMember(member)
    setSelectedRoleId(member.roles[0]?.role.id ?? '')
  }

  const handleSaveRole = () => {
    if (!editingMember || !selectedRoleId) return
    executeUpdateRole({
      membershipId: editingMember.id,
      roleId: selectedRoleId,
    })
  }

  const handleToggleActive = (member: MemberItem) => {
    executeToggleActive({
      membershipId: member.id,
      active: false,
    })
  }

  const columns: ColumnDef<MemberItem>[] = [
    {
      id: 'name',
      accessorFn: (row) => row.user.name ?? '',
      header: ({ column }) => <SortableHeader column={column}>Name</SortableHeader>,
      cell: ({ row }) => (
        <span className="font-medium">{row.original.user.name ?? '-'}</span>
      ),
    },
    {
      id: 'email',
      accessorFn: (row) => row.user.email,
      header: 'Email',
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.user.email}</span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      cell: ({ row }) => {
        if (row.original.roles.length === 0) {
          return <span className="text-muted-foreground">No role</span>
        }
        return (
          <div className="flex gap-1">
            {row.original.roles.map((r) => {
              const isAdminRole = ADMIN_ROLE_CODES.includes(r.role.code)
              return (
                <Badge key={r.role.id} variant={isAdminRole ? 'default' : 'secondary'}>
                  {r.role.name}
                </Badge>
              )
            })}
          </div>
        )
      },
    },
    {
      id: 'lastLogin',
      header: 'Last Login',
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.user.lastLoginAt
            ? new Date(row.original.user.lastLoginAt).toLocaleDateString()
            : 'Never'}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const active = row.original.user.active
        return active ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500 dark:text-emerald-400">
            <span className="inline-block size-1.5 rounded-full bg-current" />
            Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="inline-block size-1.5 rounded-full border border-current" />
            Inactive
          </span>
        )
      },
    },
    ...(canEdit
      ? [
          {
            id: 'actions',
            header: () => null,
            cell: ({ row }: { row: { original: MemberItem } }) => (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" />
                  }
                >
                  <MoreHorizontalIcon className="size-4" />
                  <span className="sr-only">Actions</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Actions</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => handleEditRole(row.original)}
                  >
                    <ShieldIcon className="size-4" />
                    Change Role
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => handleToggleActive(row.original)}
                    disabled={isToggling}
                  >
                    <UserXIcon className="size-4" />
                    Deactivate
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
            size: 48,
          } satisfies ColumnDef<MemberItem>,
        ]
      : []),
  ]

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        data={members}
        globalSearch
        searchPlaceholder="Search members..."
        pageSize={20}
        emptyState={
          <EmptyState
            icon={UsersIcon}
            title="No members yet"
            description="Invite team members to get started."
          />
        }
      />

      {/* Edit Role Dialog */}
      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Role</DialogTitle>
            <DialogDescription>
              Update role for {editingMember?.user.name ?? editingMember?.user.email}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Select
              value={selectedRoleId}
              onValueChange={(v) => setSelectedRoleId(v ?? '')}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditingMember(null)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveRole}
              disabled={isUpdatingRole || !selectedRoleId}
            >
              {isUpdatingRole ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
