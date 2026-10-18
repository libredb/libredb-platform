'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog'
import { useHotkeys } from 'react-hotkeys-hook'
import { isFromInteractiveControl } from '../lib/hotkeys'

const ROWS: Array<[string, string]> = [
  ['⌘K / /',   'Focus search'],
  ['j / k',    'Move down / up'],
  ['Enter',    'Open selected ticket'],
  ['r',        'Write a reply'],
  ['c',        'Write an internal note'],
  ['e',        'Resolve'],
  ['⌘⏎',      'Send'],
  ['Esc',      'Close / cancel'],
  ['?',        'Show this help'],
]

export function ShortcutsHelp() {
  const [open, setOpen] = useState(false)
  useHotkeys('shift+slash', () => setOpen(true), { preventDefault: true, ignoreEventWhen: isFromInteractiveControl })

  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Keyboard Shortcuts</DialogTitle></DialogHeader>
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
