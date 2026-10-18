import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TagPicker } from './tag-picker'

describe('TagPicker', () => {
  // A tag's own colour as text on a tint of that colour stays under the 4.5:1 contrast of WCAG AA in both themes.
  it("writes a ticket's tag name in the theme's foreground colour on a tint of the tag's colour", () => {
    render(
      <TagPicker
        ticketTags={[{ id: 'tag-bug', name: 'bug', colorCode: '#ef4444' }]}
        availableTags={[]}
        canManage={false}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    const chip = screen.getByText('bug')
    expect(chip).toHaveClass('text-foreground')
    expect(chip.style.color).toBe('')
    expect(chip.style.backgroundColor).not.toBe('')
  })
})
