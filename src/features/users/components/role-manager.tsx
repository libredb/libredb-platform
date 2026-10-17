'use client'

import { useState } from 'react'
import { PlusIcon, ShieldIcon, CheckIcon, XIcon, Loader2Icon } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Checkbox } from '@/shared/components/ui/checkbox'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import { Label } from '@/shared/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { useAction } from '@/shared/hooks/use-action'
import { createCustomRole, updateRolePermissions } from '../actions/manage-roles'

interface RoleItem {
  id: string
  code: string
  name: string
  isSystem: boolean
  permissions: { permissionId: string; permission: { id: string; code: string; name: string; category: string } }[]
}

interface PermissionItem {
  id: string
  code: string
  name: string
  category: string
}

interface RoleManagerProps {
  roles: RoleItem[]
  permissions: PermissionItem[]
  canCreateCustomRoles: boolean
}

export function RoleManager({ roles, permissions, canCreateCustomRoles }: RoleManagerProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleCode, setNewRoleCode] = useState('')
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)
  const [editingPermissionIds, setEditingPermissionIds] = useState<Set<string>>(new Set())

  const { execute: executeCreateRole, isPending: isCreating } = useAction(
    createCustomRole,
    {
      successMessage: 'Custom role created successfully',
      onSuccess: () => {
        setShowCreateDialog(false)
        setNewRoleName('')
        setNewRoleCode('')
      },
    },
  )

  const { execute: executeUpdatePermissions, isPending: isUpdating } = useAction(
    updateRolePermissions,
    {
      successMessage: 'Permissions updated successfully',
      onSuccess: () => setEditingRoleId(null),
    },
  )

  // Group permissions by category
  const permissionsByCategory = permissions.reduce<Record<string, PermissionItem[]>>(
    (acc, perm) => {
      const cat = perm.category
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(perm)
      return acc
    },
    {},
  )

  const categories = Object.keys(permissionsByCategory).sort()

  const handleStartEditPermissions = (role: RoleItem) => {
    setEditingRoleId(role.id)
    setEditingPermissionIds(new Set(role.permissions.map((p) => p.permissionId)))
  }

  const handleTogglePermission = (permissionId: string) => {
    setEditingPermissionIds((prev) => {
      const next = new Set(prev)
      if (next.has(permissionId)) {
        next.delete(permissionId)
      } else {
        next.add(permissionId)
      }
      return next
    })
  }

  const handleSavePermissions = () => {
    if (!editingRoleId) return
    executeUpdatePermissions({
      roleId: editingRoleId,
      permissionIds: Array.from(editingPermissionIds),
    })
  }

  const handleCreateRole = () => {
    if (!newRoleName || !newRoleCode) return
    executeCreateRole({ name: newRoleName, code: newRoleCode })
  }

  const handleNameChange = (value: string) => {
    setNewRoleName(value)
    // Auto-generate code from name
    setNewRoleCode(value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''))
  }

  return (
    <div className="space-y-6">
      {/* Roles Overview */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Roles</CardTitle>
              <CardDescription>
                Manage roles and their permissions. System roles are read-only.
              </CardDescription>
            </div>
            {canCreateCustomRoles && (
              <Button onClick={() => setShowCreateDialog(true)}>
                <PlusIcon className="size-4" data-icon="inline-start" />
                Create Custom Role
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      No roles found.
                    </TableCell>
                  </TableRow>
                ) : (
                  roles.map((role) => (
                    <TableRow key={role.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <ShieldIcon className="size-4 text-muted-foreground" />
                          {role.name}
                        </div>
                      </TableCell>
                      <TableCell>
                        <code className="text-xs text-muted-foreground">{role.code}</code>
                      </TableCell>
                      <TableCell>
                        <Badge variant={role.isSystem ? 'secondary' : 'default'}>
                          {role.isSystem ? 'System' : 'Custom'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {role.permissions.length} permission{role.permissions.length !== 1 ? 's' : ''}
                        </span>
                      </TableCell>
                      <TableCell>
                        {!role.isSystem && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleStartEditPermissions(role)}
                          >
                            Edit
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Permission Matrix */}
      <Card>
        <CardHeader>
          <CardTitle>Permission Matrix</CardTitle>
          <CardDescription>
            Overview of permissions assigned to each role. System role permissions are not editable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[200px]">Permission</TableHead>
                  {roles.map((role) => (
                    <TableHead key={role.id} className="text-center min-w-[100px]">
                      <div className="text-xs">{role.name}</div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((category) => (
                  <>
                    <TableRow key={`cat-${category}`}>
                      <TableCell
                        colSpan={roles.length + 1}
                        className="bg-muted/50 font-medium text-xs uppercase tracking-wider"
                      >
                        {category}
                      </TableCell>
                    </TableRow>
                    {permissionsByCategory[category].map((perm) => (
                      <TableRow key={perm.id}>
                        <TableCell>
                          <div>
                            <div className="text-sm">{perm.name}</div>
                            <div className="text-xs text-muted-foreground">{perm.code}</div>
                          </div>
                        </TableCell>
                        {roles.map((role) => {
                          const hasPermission = role.permissions.some(
                            (rp) => rp.permissionId === perm.id,
                          )
                          return (
                            <TableCell key={`${role.id}-${perm.id}`} className="text-center">
                              {hasPermission ? (
                                <CheckIcon className="mx-auto size-4 text-green-600" />
                              ) : (
                                <XIcon className="mx-auto size-4 text-muted-foreground/30" />
                              )}
                            </TableCell>
                          )
                        })}
                      </TableRow>
                    ))}
                  </>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Create Custom Role Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Custom Role</DialogTitle>
            <DialogDescription>
              Create a new custom role for your organization. You can assign permissions after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="role-name">Role Name</Label>
              <Input
                id="role-name"
                placeholder="e.g. Data Analyst"
                value={newRoleName}
                onChange={(e) => handleNameChange(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role-code">Role Code</Label>
              <Input
                id="role-code"
                placeholder="e.g. DATA_ANALYST"
                value={newRoleCode}
                onChange={(e) => setNewRoleCode(e.target.value.toUpperCase().replace(/[^A-Z_]/g, ''))}
              />
              <p className="text-xs text-muted-foreground">
                Uppercase letters and underscores only. Auto-generated from name.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateRole}
              disabled={isCreating || !newRoleName || !newRoleCode}
            >
              {isCreating ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" />
                  Creating...
                </>
              ) : (
                'Create Role'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Permissions Dialog */}
      <Dialog open={!!editingRoleId} onOpenChange={(open) => !open && setEditingRoleId(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Permissions</DialogTitle>
            <DialogDescription>
              Select the permissions for this role.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {categories.map((category) => (
              <div key={category} className="space-y-2">
                <h4 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                  {category}
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  {permissionsByCategory[category].map((perm) => (
                    <label
                      key={perm.id}
                      className="flex items-center gap-2 rounded-md border p-2 cursor-pointer hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={editingPermissionIds.has(perm.id)}
                        onCheckedChange={() => handleTogglePermission(perm.id)}
                      />
                      <div>
                        <div className="text-sm">{perm.name}</div>
                        <div className="text-xs text-muted-foreground">{perm.code}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingRoleId(null)}>
              Cancel
            </Button>
            <Button onClick={handleSavePermissions} disabled={isUpdating}>
              {isUpdating ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" />
                  Saving...
                </>
              ) : (
                'Save Permissions'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
