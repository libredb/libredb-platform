'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Avatar, AvatarFallback } from '@/shared/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { LogOut, User, Settings, Loader2 } from 'lucide-react'
import { logoutAction } from '@/features/auth/actions/logout'
import type { CurrentUser } from '@/shared/types'

export function UserNav({ user }: { user: CurrentUser }) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const initials = user.name
    ?.split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase() ?? user.email[0].toUpperCase()

  const handleLogout = () => {
    startTransition(async () => {
      await logoutAction()
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors dark:hover:bg-white/[0.03]"
      >
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-primary/15 text-primary text-xs font-semibold">{initials}</AvatarFallback>
        </Avatar>
        <div className="grid flex-1 text-left text-sm leading-tight">
          <span className="truncate font-medium">{user.name ?? 'User'}</span>
          <span className="truncate text-xs text-muted-foreground">{user.email}</span>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>My Account</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <User className="mr-2 h-4 w-4" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push('/settings')}>
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={handleLogout} disabled={isPending}>
            {isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <LogOut className="mr-2 h-4 w-4" />
            )}
            {isPending ? 'Signing out...' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
