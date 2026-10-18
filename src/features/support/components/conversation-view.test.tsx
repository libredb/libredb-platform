import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../hooks/use-ticket', () => ({
  useTicket: (_id: string, initialTicket: unknown) => ({ data: initialTicket }),
  useSendMessage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateTicket: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('../hooks/use-attachment-upload', () => ({ useAttachmentUpload: () => ({ upload: vi.fn() }) }))
vi.mock('../actions/add-tag', () => ({ addTag: vi.fn() }))
vi.mock('../actions/remove-tag', () => ({ removeTag: vi.fn() }))
vi.mock('../actions/reopen-ticket', () => ({ reopenTicket: vi.fn() }))
// The parts around the view's own markup render nothing here, so the test reads only the view's text.
vi.mock('./conversation-header', () => ({ ConversationHeader: () => null }))
vi.mock('./conversation-sidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('./conversation-timeline', () => ({ ConversationTimeline: () => null }))
vi.mock('./reply-composer', () => ({ ReplyComposer: () => null }))
vi.mock('./dropzone-overlay', () => ({ DropzoneOverlay: () => null }))
vi.mock('./csat-prompt', () => ({ CsatPrompt: () => null }))

import { ConversationView } from './conversation-view'

const TICKET = {
  id: 'ticket-1',
  status: 'OPEN',
  createdByUserId: 'user-creator',
  satisfactionRating: null,
  messages: [],
  activities: [],
  tags: [],
}

function renderView() {
  return render(
    <ConversationView
      ticketId="ticket-1"
      initialTicket={TICKET}
      currentUserId="user-creator"
      canManage={false}
      canSeeInternal={false}
      statusValues={[]}
      priorityValues={[]}
      categoryValues={[]}
      members={[]}
      availableTags={[]}
      userMap={{}}
      statusMap={{}}
      priorityMap={{}}
      platformStaffIds={[]}
      customerName="Sarah Chen"
      customerEmail="sarah.chen@acme.test"
      tenantName="Acme"
      tenantSlug="acme"
      tenantPlan={null}
    />,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ConversationView', () => {
  it('tells an offline user that the connection is lost and will be retried, with a comma between', () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)

    renderView()

    expect(screen.getByText('Connection lost, will retry automatically')).toBeInTheDocument()
  })
})
