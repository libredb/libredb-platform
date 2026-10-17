import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { Editor, JSONContent } from '@tiptap/react'

// The mention suggestion searches platform staff through a Server Action, whose imports reach Auth.js; text without
// an @ never calls it.
vi.mock('@/features/support/actions/search-staff', () => ({ searchPlatformStaff: vi.fn() }))

import { ReplyComposer } from './reply-composer'
import { sanitizeTicketHtml } from '@/features/support/lib/support-sanitize'

/** The TipTap editor that the composer mounted, which TipTap keeps on the editor's DOM element. */
function mountedEditor(container: HTMLElement): Editor {
  const element = container.querySelector<HTMLElement & { editor?: Editor }>('.ProseMirror')
  if (!element?.editor) throw new Error('the composer mounted no TipTap editor')
  return element.editor
}

const text = (value: string): JSONContent => ({ type: 'text', text: value })
const marked = (value: string, mark: string, attrs?: Record<string, unknown>): JSONContent =>
  ({ type: 'text', text: value, marks: [{ type: mark, attrs }] })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const listItem = (value: string): JSONContent => ({ type: 'listItem', content: [paragraph(text(value))] })
const taskList = (...content: JSONContent[]): JSONContent => ({ type: 'taskList', content })
const taskItem = (checked: boolean, ...content: JSONContent[]): JSONContent =>
  ({ type: 'taskItem', attrs: { checked }, content })

/**
 * Content that each composer feature creates, with the attributes its command or input rule sets, and a selector that
 * its HTML must match, so that content the editor failed to render cannot pass.
 */
const COMPOSER_CONTENT: Array<[string, JSONContent, string]> = [
  ['a paragraph with a hard break', paragraph(text('Merhaba'), { type: 'hardBreak' }, text('dünya')), 'p > br'],
  [
    'bold, italic, underline and strike text',
    paragraph(marked('b', 'bold'), marked('i', 'italic'), marked('u', 'underline'), marked('s', 'strike')),
    'p > strong + em + u + s',
  ],
  ['inline code', paragraph(marked('SELECT 1', 'code')), 'p > code'],
  [
    'a link from the toolbar',
    paragraph(marked('docs', 'link', { href: 'https://example.com/docs' })),
    'a[href="https://example.com/docs"][target="_blank"][rel="noopener noreferrer"]',
  ],
  [
    'a mention',
    paragraph({ type: 'mention', attrs: { id: 'u1', label: 'Ayşe' } }),
    'span.mention-chip[data-type="mention"][data-mention-id="u1"][data-mention-label="Ayşe"]',
  ],
  ['a bullet list', { type: 'bulletList', content: [listItem('one')] }, 'ul:not([data-type]) > li > p'],
  ['an ordered list', { type: 'orderedList', content: [listItem('one')] }, 'ol:not([start]) > li > p'],
  [
    'an ordered list typed as "3. "',
    { type: 'orderedList', attrs: { start: 3 }, content: [listItem('three')] },
    'ol[start="3"] > li > p',
  ],
  ['a blockquote', { type: 'blockquote', content: [paragraph(text('quote'))] }, 'blockquote > p'],
  ['a code block from the toolbar', { type: 'codeBlock', content: [text('SELECT 1;')] }, 'pre > code:not([class])'],
  [
    'a code block typed as "```sql"',
    { type: 'codeBlock', attrs: { language: 'sql' }, content: [text('SELECT 1;')] },
    'pre > code.language-sql',
  ],
  ['a horizontal rule', { type: 'horizontalRule' }, 'hr'],
  [
    'a pasted image on the attachment route',
    { type: 'image', attrs: { src: '/support/api/attachments/tmp/k1' } },
    'img[src="/support/api/attachments/tmp/k1"]',
  ],
  [
    'a checked task item',
    taskList(taskItem(true, paragraph(text('done')))),
    'ul[data-type="taskList"] > li[data-type="taskItem"][data-checked="true"] > label > input[type="checkbox"][checked]',
  ],
  [
    'an open task item',
    taskList(taskItem(false, paragraph(text('open')))),
    'li[data-type="taskItem"][data-checked="false"] > label > input[type="checkbox"]:not([checked])',
  ],
  [
    'a nested task item',
    taskList(taskItem(false, paragraph(text('parent')), taskList(taskItem(false, paragraph(text('child')))))),
    'li[data-type="taskItem"] > div > ul[data-type="taskList"] > li[data-type="taskItem"]',
  ],
]

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

  it.each(COMPOSER_CONTENT)('keeps %s through sanitizeTicketHtml unchanged', async (_name, content, selector) => {
    const { container } = render(<ReplyComposer allowInternalToggle={false} onSend={vi.fn()} />)
    await screen.findByRole('button', { name: 'Gönder' })
    const editor = mountedEditor(container)
    act(() => {
      editor.commands.setContent({ type: 'doc', content: [content] })
    })

    // The composer sends this HTML as bodyRich.
    const html = editor.getHTML()
    expect(new DOMParser().parseFromString(html, 'text/html').body.querySelector(selector)).not.toBeNull()
    expect(sanitizeTicketHtml(html)).toBe(html)
  })
})
