import { forwardRef, useImperativeHandle, useState } from 'react'

export interface MentionCandidate { id: string; name: string | null; email: string }

interface MentionListProps {
  items: MentionCandidate[]
  command: (item: { id: string; label: string }) => void
}

export const MentionList = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  MentionListProps
>(function MentionListImpl({ items, command }, ref) {
  // Reset highlighted index whenever the candidate list changes.
  // React's "Adjusting State While Rendering" pattern: the set-state call
  // during render causes React to discard the current JSX and re-render
  // once with the reset state (single extra render, not a cascade). A
  // useRef approach would be more efficient but trips the new
  // react-hooks/refs rule which forbids reading or mutating refs during
  // render. useEffect would trip react-hooks/set-state-in-effect. This
  // pattern is the only one all three rules allow.
  const [prevItems, setPrevItems] = useState(items)
  const [index, setIndex] = useState(0)
  if (prevItems !== items) {
    setPrevItems(items)
    setIndex(0)
  }

  const pick = (i: number) => {
    const item = items[i]
    if (!item) return
    command({ id: item.id, label: item.name ?? item.email })
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        setIndex(i => (i + 1) % Math.max(items.length, 1))
        return true
      }
      if (event.key === 'ArrowUp') {
        setIndex(i => (i + items.length - 1) % Math.max(items.length, 1))
        return true
      }
      if (event.key === 'Enter') {
        pick(index)
        return true
      }
      return false
    },
  }))

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md">
        No matching agents
      </div>
    )
  }

  return (
    <div className="min-w-[220px] rounded-md border border-border bg-popover p-1 shadow-md">
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          onClick={() => pick(i)}
          className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs ${i === index ? 'bg-accent' : 'hover:bg-accent/50'}`}
        >
          <span className="font-medium">{item.name ?? item.email}</span>
          {item.name && <span className="text-muted-foreground">{item.email}</span>}
        </button>
      ))}
    </div>
  )
})
