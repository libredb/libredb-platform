import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { UserRepository } from '@/features/users/lib/user.repository'
import { Badge } from '@/shared/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'

export default async function AdminUsersPage() {
  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const members = await UserRepository.findAll()

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">All Users</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide view of all users across tenants.
        </p>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Tenant</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last Login</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-24 text-center text-muted-foreground"
                >
                  No users found.
                </TableCell>
              </TableRow>
            ) : (
              members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">
                    {member.user.name ?? '-'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {member.user.email}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{member.tenant.name}</Badge>
                  </TableCell>
                  <TableCell>
                    {member.roles.map((r) => (
                      <Badge key={r.role.id} variant="secondary" className="mr-1">
                        {r.role.name}
                      </Badge>
                    ))}
                    {member.roles.length === 0 && (
                      <span className="text-muted-foreground">No role</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {member.user.lastLoginAt
                      ? new Date(member.user.lastLoginAt).toLocaleDateString()
                      : 'Never'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={member.user.active ? 'default' : 'destructive'}>
                      {member.user.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
