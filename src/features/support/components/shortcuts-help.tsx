'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog'
import { useHotkeys } from 'react-hotkeys-hook'

const ROWS: Array<[string, string]> = [
  ['⌘K / /',   'Arama kutusu'],
  ['j / k',    'Aşağı / yukarı'],
  ['Enter',    'Seçili ticket aç'],
  ['r',        'Yanıt yaz'],
  ['c',        'Internal note yaz'],
  ['e',        'Resolve'],
  ['⌘⏎',      'Gönder'],
  ['Esc',      'Kapat / iptal'],
  ['?',        'Bu pencere'],
]

export function ShortcutsHelp() {
  const [open, setOpen] = useState(false)
  useHotkeys('shift+slash', () => setOpen(true), { preventDefault: true })

  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Klavye Kısayolları</DialogTitle></DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {ROWS.map(([k, v], i) => (
            <div key={i} className="contents">
              <dt className="font-mono text-xs text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
