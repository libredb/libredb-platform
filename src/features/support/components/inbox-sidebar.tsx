'use client'

import Link from 'next/link'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { buttonVariants } from '@/shared/components/ui/button'
import { PlusIcon } from 'lucide-react'

interface TagRef { id: string; name: string; colorCode: string | null }

const VIEWS: { key: string; label: string }[] = [
  { key: 'open',       label: 'Open' },
  { key: 'mine',       label: 'Assigned to me' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'high',       label: 'High priority' },
  { key: 'all',        label: 'All' },
  { key: 'closed',     label: 'Closed' },
]

export function InboxSidebar({ availableTags }: { availableTags: TagRef[] }) {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const currentView = sp.get('view') ?? 'open'
  const activeTags = new Set(sp.getAll('tag'))

  const setView = (key: string) => {
    const next = new URLSearchParams(sp)
    next.set('view', key)
    router.push(`${pathname}?${next.toString()}`, { scroll: false })
  }

  const toggleTag = (id: string) => {
    const next = new URLSearchParams()
    if (sp.get('view')) next.set('view', sp.get('view')!)
    if (sp.get('q'))    next.set('q', sp.get('q')!)
    const updated = new Set(activeTags)
    updated.has(id) ? updated.delete(id) : updated.add(id)
    for (const t of updated) next.append('tag', t)
    router.push(`${pathname}?${next.toString()}`, { scroll: false })
  }

  return (
    <nav className="flex flex-col gap-1 p-3 text-sm">
      <Link href="/support/new" className={buttonVariants({ size: 'sm' }) + ' mb-2 w-full justify-start'}>
        <PlusIcon className="size-4" /> New Ticket
      </Link>
      <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">Views</div>
      {VIEWS.map(v => (
        <button
          key={v.key}
          onClick={() => setView(v.key)}
          className={`rounded px-2 py-1 text-left transition-colors ${currentView === v.key ? 'bg-accent' : 'hover:bg-accent/50'}`}
        >
          {v.label}
        </button>
      ))}
      <div className="mb-1 mt-4 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">Tags</div>
      {availableTags.length === 0 && <div className="px-1 text-xs text-muted-foreground">No tags yet</div>}
      {availableTags.map(t => (
        <button
          key={t.id}
          onClick={() => toggleTag(t.id)}
          className={`flex items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors ${activeTags.has(t.id) ? 'bg-accent' : 'hover:bg-accent/50'}`}
        >
          <span className="size-2 rounded-full" style={{ backgroundColor: t.colorCode ?? 'var(--muted-foreground)' }} />
          {t.name}
        </button>
      ))}
    </nav>
  )
}
