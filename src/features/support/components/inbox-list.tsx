'use client'

import { useParams, useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useState } from 'react'
import { Input } from '@/shared/components/ui/input'
import { SearchIcon } from 'lucide-react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useInbox } from '../hooks/use-inbox'
import { InboxListRow } from './inbox-list-row'

export function InboxList() {
  const { data, isLoading, error } = useInbox()
  const { id } = useParams() as { id?: string }
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [q, setQ] = useState(sp.get('q') ?? '')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const ticketCount = data?.tickets?.length ?? 0

  useHotkeys('j', () => setSelectedIdx(i => Math.min((data?.tickets?.length ?? 1) - 1, i + 1)), [data])
  useHotkeys('k', () => setSelectedIdx(i => Math.max(0, i - 1)), [])
  useHotkeys('enter', () => {
    const t = data?.tickets?.[selectedIdx]
    if (t) router.push(`/support/${t.id}`)
  }, [data, selectedIdx])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const next = new URLSearchParams(sp)
    if (q) next.set('q', q); else next.delete('q')
    router.push(`${pathname}?${next.toString()}`, { scroll: false })
  }

  return (
    <div>
      <div className="sticky top-0 z-10 space-y-2 border-b bg-card p-2">
        <form onSubmit={onSubmit} className="relative">
          <SearchIcon className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search..." className="h-8 pl-7 text-xs" />
        </form>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{ticketCount} {ticketCount === 1 ? 'ticket' : 'tickets'}</span>
          <span>Updated &#8595;</span>
        </div>
      </div>
      {isLoading && <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>}
      {error && <div className="p-6 text-center text-sm text-destructive">Could not load the list</div>}
      {data?.tickets?.map((t: any, i: number) => (
        <InboxListRow key={t.id} ticket={t} active={i === selectedIdx || t.id === id} href={`/support/${t.id}`} />
      ))}
      {data && data.tickets.length === 0 && (
        <div className="p-6 text-center text-sm text-muted-foreground">
          {q ? 'No results' : 'No tickets'}
        </div>
      )}
    </div>
  )
}
