import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { db } from '@/shared/lib/db'
import { Badge } from '@/shared/components/ui/badge'
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

interface MenuTreeItem {
  id: string
  code: string
  name: string
  url: string | null
  icon: string | null
  sortOrder: number
  level: number
  active: boolean
  children: MenuTreeItem[]
}

function buildMenuTree(
  menus: { id: string; code: string; name: string; url: string | null; icon: string | null; sortOrder: number; level: number; active: boolean; parentId: string | null }[],
): MenuTreeItem[] {
  const itemMap = new Map<string, MenuTreeItem>()

  for (const m of menus) {
    itemMap.set(m.id, { ...m, children: [] })
  }

  const roots: MenuTreeItem[] = []
  for (const m of menus) {
    const item = itemMap.get(m.id)!
    if (m.parentId && itemMap.has(m.parentId)) {
      itemMap.get(m.parentId)!.children.push(item)
    } else {
      roots.push(item)
    }
  }

  return roots
}

function MenuTreeRows({ items, depth = 0 }: { items: MenuTreeItem[]; depth?: number }) {
  return (
    <>
      {items.map((item) => (
        <>
          <TableRow key={item.id}>
            <TableCell>
              <div style={{ paddingLeft: `${depth * 24}px` }} className="flex items-center gap-2">
                {depth > 0 && <span className="text-muted-foreground">{'--'}</span>}
                <span className="font-medium">{item.name}</span>
              </div>
            </TableCell>
            <TableCell>
              <code className="text-xs text-muted-foreground">{item.code}</code>
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {item.url ?? '-'}
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {item.icon ?? '-'}
            </TableCell>
            <TableCell className="text-center text-sm">
              {item.sortOrder}
            </TableCell>
            <TableCell className="text-center">
              {item.level}
            </TableCell>
            <TableCell>
              <Badge variant={item.active ? 'default' : 'secondary'}>
                {item.active ? 'Active' : 'Inactive'}
              </Badge>
            </TableCell>
          </TableRow>
          {item.children.length > 0 && (
            <MenuTreeRows items={item.children} depth={depth + 1} />
          )}
        </>
      ))}
    </>
  )
}

export default async function MenusPage() {
  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const menus = await db.menu.findMany({
    orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }],
  })

  const tree = buildMenuTree(menus)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Menu Management</h1>
        <p className="text-sm text-muted-foreground">
          View the menu hierarchy and configuration. Edit functionality coming soon.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Menu Hierarchy</CardTitle>
          <CardDescription>
            All platform menus organized by their parent-child relationships.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[200px]">Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Icon</TableHead>
                  <TableHead className="text-center">Sort Order</TableHead>
                  <TableHead className="text-center">Level</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tree.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      No menus configured yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  <MenuTreeRows items={tree} />
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
