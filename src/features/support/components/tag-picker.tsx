'use client'

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/shared/components/ui/command'
import { Button } from '@/shared/components/ui/button'
import { XIcon, PlusIcon } from 'lucide-react'

interface TagRef { id: string; name: string; colorCode: string | null }

interface TagPickerProps {
  ticketTags: TagRef[]
  availableTags: TagRef[]
  canManage: boolean
  onAdd: (tagId: string) => void
  onRemove: (tagId: string) => void
}

export function TagPicker({ ticketTags, availableTags, canManage, onAdd, onRemove }: TagPickerProps) {
  const [open, setOpen] = useState(false)
  const ticketIds = new Set(ticketTags.map(t => t.id))
  const pickable = availableTags.filter(t => !ticketIds.has(t.id))

  return (
    <div className="flex flex-wrap gap-1">
      {ticketTags.map(t => (
        <span
          key={t.id}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-foreground"
          style={{ backgroundColor: (t.colorCode ?? '#6366f1') + '22' }}
        >
          {t.name}
          {canManage && (
            <button onClick={() => onRemove(t.id)} aria-label={`Remove ${t.name}`} type="button">
              <XIcon className="size-2.5" />
            </button>
          )}
        </span>
      ))}
      {canManage && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button variant="outline" size="sm" className="h-5 gap-1 px-1.5 text-[10px]">
                <PlusIcon className="size-3" /> Add
              </Button>
            }
          />
          <PopoverContent className="w-56 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search tags..." />
              <CommandList>
                <CommandEmpty>No results</CommandEmpty>
                <CommandGroup>
                  {pickable.map(t => (
                    <CommandItem
                      key={t.id}
                      onSelect={() => { onAdd(t.id); setOpen(false) }}
                    >
                      <span className="mr-2 size-2 rounded-full" style={{ backgroundColor: t.colorCode ?? 'var(--muted-foreground)' }} />
                      {t.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
