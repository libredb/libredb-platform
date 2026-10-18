import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { ShortcutsHelp } from './shortcuts-help'

/** Presses ?, Shift with the slash key, with the keyboard focus on `target`. */
function pressQuestionMark(target: Element) {
  fireEvent.keyDown(target, { key: '?', code: 'Slash', shiftKey: true })
  fireEvent.keyUp(target, { key: '?', code: 'Slash', shiftKey: true })
}

describe('ShortcutsHelp', () => {
  it('opens on ? typed on the page', async () => {
    render(<ShortcutsHelp />)

    pressQuestionMark(document.body)

    expect(await screen.findByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeInTheDocument()
  })

  it('stays closed on ? typed on a focused select', () => {
    const items = [{ value: 'MEDIUM', label: 'Medium' }]
    render(
      <>
        <ShortcutsHelp />
        <Select items={items} defaultValue="MEDIUM">
          <SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
          <SelectContent>{items.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}</SelectContent>
        </Select>
      </>,
    )
    const priority = screen.getByRole('combobox', { name: 'Priority' })
    priority.focus()

    pressQuestionMark(priority)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
