'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as LucideIcons from 'lucide-react'
import type { MenuItem } from '@/shared/lib/menu'
import type { CurrentUser } from '@/shared/types'
import type { DeploymentMode } from '@/shared/lib/deployment'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarHeader,
  SidebarFooter,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarRail,
} from '@/shared/components/ui/sidebar'
import { TenantSwitcher } from './tenant-switcher'
import { UserNav } from './user-nav'

function DynamicIcon({ name, ...props }: { name: string } & LucideIcons.LucideProps) {
  const iconName = name
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('') as keyof typeof LucideIcons
  const Icon = (LucideIcons[iconName] as React.ComponentType<LucideIcons.LucideProps>) ?? LucideIcons.Circle
  return <Icon {...props} />
}

interface AppSidebarProps {
  deploymentMode: DeploymentMode
  menus: MenuItem[]
  user: CurrentUser
  currentTenant: { id: string; name: string; slug: string } | null
}

export function AppSidebar({ deploymentMode, menus, user, currentTenant }: AppSidebarProps) {
  const pathname = usePathname()

  // Separate menus into main navigation and admin section
  const adminMenu = menus.find(m => m.code === 'ADMIN')
  const mainMenus = menus.filter(m => m.code !== 'ADMIN')

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <TenantSwitcher
              deploymentMode={deploymentMode}
              currentTenant={currentTenant}
              accessibleTenants={user.accessibleTenants}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* Main Navigation */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Navigation</SidebarGroupLabel>
          <SidebarMenu>
            {mainMenus.map(item => (
              <NavItem key={item.id} item={item} pathname={pathname} />
            ))}
          </SidebarMenu>
        </SidebarGroup>

        {/* Admin Section */}
        {adminMenu && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Administration</SidebarGroupLabel>
            <SidebarMenu>
              {adminMenu.children.length > 0 ? (
                adminMenu.children.map(child => (
                  <NavItem key={child.id} item={child} pathname={pathname} />
                ))
              ) : (
                <NavItem item={adminMenu} pathname={pathname} />
              )}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <UserNav user={user} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

// External items (such as Studio) leave Platform, so they open in a new tab without next/link.
function linkElement(url: string, external: boolean) {
  return external
    ? <a href={url} target="_blank" rel="noopener noreferrer" />
    : <Link href={url} />
}

function NavItem({ item, pathname }: { item: MenuItem; pathname: string }) {
  const isActive = item.url ? pathname === item.url || pathname.startsWith(item.url + '/') : false
  const hasChildren = item.children.length > 0

  if (hasChildren) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={item.name}
          isActive={isActive}
          render={
            item.url ? linkElement(item.url, item.external) : <button type="button" />
          }
        >
          {item.icon && <DynamicIcon name={item.icon} />}
          <span>{item.name}</span>
        </SidebarMenuButton>
        <SidebarMenuSub>
          {item.children.map(child => {
            const childActive = child.url
              ? pathname === child.url || pathname.startsWith(child.url + '/')
              : false
            return (
              <SidebarMenuSubItem key={child.id}>
                <SidebarMenuSubButton
                  isActive={childActive}
                  render={
                    child.url ? linkElement(child.url, child.external) : <span />
                  }
                >
                  <span>{child.name}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )
          })}
        </SidebarMenuSub>
      </SidebarMenuItem>
    )
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={item.name}
        isActive={isActive}
        render={
          item.url ? linkElement(item.url, item.external) : <button type="button" />
        }
      >
        {item.icon && <DynamicIcon name={item.icon} />}
        <span>{item.name}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
