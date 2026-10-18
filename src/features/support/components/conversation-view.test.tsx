import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'

// The update hook of the mocked ticket hooks, so a test can see whether a hotkey resolved the ticket.
const update = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => ({ success: true })) }))
vi.mock('../hooks/use-ticket', () => ({
  useTicket: (_id: string, initialTicket: unknown) => ({ data: initialTicket }),
  useSendMessage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateTicket: () => update,
}))
vi.mock('../hooks/use-attachment-upload', () => ({ useAttachmentUpload: () => ({ upload: vi.fn() }) }))
vi.mock('../actions/add-tag', () => ({ addTag: vi.fn() }))
vi.mock('../actions/remove-tag', () => ({ removeTag: vi.fn() }))
vi.mock('../actions/reopen-ticket', () => ({ reopenTicket: vi.fn() }))
// The parts around the view's own markup render nothing here, except the sidebar, whose selects the hotkey tests focus.
vi.mock('./conversation-header', () => ({ ConversationHeader: () => null }))
vi.mock('./conversation-timeline', () => ({ ConversationTimeline: () => null }))
vi.mock('./reply-composer', () => ({ ReplyComposer: () => null }))
vi.mock('./dropzone-overlay', () => ({ DropzoneOverlay: () => null }))
vi.mock('./csat-prompt', () => ({ CsatPrompt: () => null }))

import { ConversationView } from './conversation-view'
import { ShortcutsHelp } from './shortcuts-help'

const TICKET = {
  id: 'ticket-1',
  status: 'OPEN',
  priority: 'MEDIUM',
  category: 'GENERAL',
  assignedToUserId: null,
  createdByUserId: 'user-creator',
  createdAt: '2026-10-18T09:00:00.000Z',
  firstResponseAt: null,
  resolvedAt: null,
  reopenedCount: 0,
  satisfactionRating: null,
  messages: [],
  activities: [],
  tags: [],
}

function viewProps(overrides: Partial<ComponentProps<typeof ConversationView>> = {}): ComponentProps<typeof ConversationView> {
  return {
    ticketId: 'ticket-1',
    initialTicket: TICKET,
    currentUserId: 'user-creator',
    canManage: false,
    canSeeInternal: false,
    statusValues: [],
    priorityValues: [],
    categoryValues: [],
    members: [],
    availableTags: [],
    userMap: {},
    statusMap: {},
    priorityMap: {},
    platformStaffIds: [],
    customerName: 'Sarah Chen',
    customerEmail: 'sarah.chen@acme.com',
    tenantName: 'Acme',
    tenantSlug: 'acme',
    tenantPlan: null,
    ...overrides,
  }
}

function renderView(overrides: Partial<ComponentProps<typeof ConversationView>> = {}) {
  return render(<ConversationView {...viewProps(overrides)} />)
}

/** Presses e, the hotkey that resolves the ticket, with the keyboard focus on `target`. */
function pressE(target: Element) {
  fireEvent.keyDown(target, { key: 'e', code: 'KeyE' })
  fireEvent.keyUp(target, { key: 'e', code: 'KeyE' })
}

afterEach(() => {
  vi.restoreAllMocks()
  update.mutateAsync.mockClear()
})

describe('ConversationView', () => {
  it('tells an offline user that the connection is lost and will be retried, with a comma between', () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)

    renderView()

    expect(screen.getByText('Connection lost, will retry automatically')).toBeInTheDocument()
  })

  it('resolves the ticket on e typed on the page', () => {
    renderView({ canManage: true })

    pressE(document.body)

    expect(update.mutateAsync).toHaveBeenCalledWith({ status: 'RESOLVED' })
  })

  // A closed select of the sidebar keeps the focus after it closes, so the next key goes to its trigger.
  it('leaves the ticket alone on e typed on a focused select of the sidebar', () => {
    renderView({ canManage: true })
    const priority = screen.getByRole('combobox', { name: 'Priority' })
    priority.focus()

    pressE(priority)

    expect(update.mutateAsync).not.toHaveBeenCalled()
  })

  it('leaves the ticket alone on e typed on a focused button', () => {
    renderView({ canManage: true })
    const reply = screen.getByRole('button', { name: 'Reply' })
    reply.focus()

    pressE(reply)

    expect(update.mutateAsync).not.toHaveBeenCalled()
  })

  // A click on the help's text gives the focus to the dialog itself.
  it('leaves the ticket alone on e typed inside the open shortcuts help', async () => {
    render(<><ConversationView {...viewProps({ canManage: true })} /><ShortcutsHelp /></>)
    fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true })
    fireEvent.keyUp(document.body, { key: '?', code: 'Slash', shiftKey: true })
    const help = await screen.findByRole('dialog', { name: 'Keyboard Shortcuts' })
    help.focus()

    pressE(help)

    expect(update.mutateAsync).not.toHaveBeenCalled()
  })
})
