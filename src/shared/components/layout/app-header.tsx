'use client'

import { Fragment } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { SidebarTrigger } from '@/shared/components/ui/sidebar'
import { Separator } from '@/shared/components/ui/separator'
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/shared/components/ui/breadcrumb'
import { NotificationBell } from '@/features/notifications/components/notification-bell'

const ROUTE_LABELS: Record<string, string> = {
  connections: 'Connections',
  team: 'Team',
  audit: 'Audit Log',
  billing: 'Billing',
  settings: 'Settings',
  support: 'Support',
  admin: 'Admin',
  dashboard: 'Dashboard',
  tenants: 'Tenants',
  users: 'Users',
  menus: 'Menus',
  plans: 'Plans',
  'reference-data': 'Reference Data',
  license: 'License',
  new: 'New',
  invitations: 'Invitations',
  'studio-users': 'Studio Users',
  'studio-settings': 'Studio Settings',
}

// The ids a path carries: a cuid, which Prisma's @default(cuid()) gives most rows, such as a ticket or a tenant, and a
// UUID, such as a connection's id, which Platform generates with crypto.randomUUID().
const CUID = /^c[a-z0-9]{24}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isId(segment: string): boolean {
  return CUID.test(segment) || UUID.test(segment)
}

export function AppHeader() {
  const pathname = usePathname()
  const segments = pathname.split('/').filter(Boolean)

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-border bg-background/80 px-6 backdrop-blur-md supports-backdrop-filter:bg-background/60">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-6" />
      <Breadcrumb>
        <BreadcrumbList>
          {segments.map((segment, index) => {
            const isLast = index === segments.length - 1
            const href = '/' + segments.slice(0, index + 1).join('/')
            const label = ROUTE_LABELS[segment] || segment

            // An id names a record, not a page, so the breadcrumb leaves it out
            if (isId(segment)) return null

            // The separator is an <li> of its own beside the item: inside the item, the browser would end the item at it.
            return (
              <Fragment key={href}>
                {index > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {isLast ? (
                    <BreadcrumbPage>{label}</BreadcrumbPage>
                  ) : (
                    <Link href={href} className="transition-colors hover:text-foreground">
                      {label}
                    </Link>
                  )}
                </BreadcrumbItem>
              </Fragment>
            )
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex-1" />
      <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1 dark:bg-white/5">
        <NotificationBell />
      </div>
    </header>
  )
}
