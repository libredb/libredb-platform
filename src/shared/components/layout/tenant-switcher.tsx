'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { ChevronsUpDown, Loader2, Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { switchTenantAction } from '@/features/auth/actions/switch-tenant'
import type { DeploymentMode } from '@/shared/lib/deployment'

interface TenantSwitcherProps {
  deploymentMode: DeploymentMode
  currentTenant: { id: string; name: string; slug: string } | null
  accessibleTenants: { id: string; name: string; slug: string }[]
}

export function TenantSwitcher({ deploymentMode, currentTenant, accessibleTenants }: TenantSwitcherProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!currentTenant) return null

  const monogram = currentTenant.name.charAt(0).toUpperCase()

  // Self-hosted mode has one install tenant and no tenant switching.
  if (deploymentMode === 'self-hosted') {
    return (
      <div className="flex w-full items-center gap-2 rounded-lg p-2 text-left">
        <TenantLabel monogram={monogram} tenant={currentTenant} />
      </div>
    )
  }

  const handleSwitchTenant = (tenantId: string) => {
    if (tenantId === currentTenant.id) return

    startTransition(async () => {
      await switchTenantAction(tenantId)
      router.refresh()
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors dark:hover:bg-white/[0.03]"
      >
        <TenantLabel monogram={isPending ? <Loader2 className="size-4 animate-spin" /> : monogram} tenant={currentTenant} />
        {accessibleTenants.length > 1 && <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />}
      </DropdownMenuTrigger>
      {accessibleTenants.length > 1 && (
        <DropdownMenuContent align="start" side="bottom" className="w-56">
          {accessibleTenants.map(tenant => (
            <DropdownMenuItem
              key={tenant.id}
              className={tenant.id === currentTenant.id ? 'bg-primary/10 text-primary' : ''}
              onClick={() => handleSwitchTenant(tenant.id)}
              disabled={isPending}
            >
              <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary mr-2">
                {tenant.name.charAt(0).toUpperCase()}
              </span>
              {tenant.name}
              {tenant.id === currentTenant.id && <Check className="ml-auto size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  )
}

function TenantLabel({ monogram, tenant }: { monogram: React.ReactNode; tenant: { name: string; slug: string } }) {
  return (
    <>
      <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary/15 text-sm font-semibold text-primary">
        {monogram}
      </div>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-semibold">{tenant.name}</span>
        <span className="truncate text-xs text-muted-foreground">{tenant.slug}</span>
      </div>
    </>
  )
}
