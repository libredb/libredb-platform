import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/react'

// The mention suggestion searches platform staff through a Server Action, whose imports reach Auth.js; text without
// an @ never calls it.
vi.mock('@/features/support/actions/search-staff', () => ({ searchPlatformStaff: vi.fn() }))

import { ReplyComposer } from './reply-composer'

/** The TipTap editor that the composer mounted, which TipTap keeps on the editor's DOM element. */
function mountedEditor(container: HTMLElement): Editor {
  const element = container.querySelector<HTMLElement & { editor?: Editor }>('.ProseMirror')
  if (!element?.editor) throw new Error('the composer mounted no TipTap editor')
  return element.editor
}

describe('ReplyComposer', () => {
  it('enables the send button once the editor holds text', async () => {
    const { container } = render(<ReplyComposer allowInternalToggle={false} onSend={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Gönder' })).toBeDisabled()

    const editor = mountedEditor(container)
    act(() => {
      editor.commands.insertContent('Bağlanamıyorum')
    })

    expect(editor.getText()).toBe('Bağlanamıyorum')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gönder' })).toBeEnabled())
  })
})
