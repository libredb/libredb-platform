import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// The Server Action reaches the database, and rendering the prompt never calls it.
vi.mock('../actions/submit-csat', () => ({ submitCsat: vi.fn() }))

import { CsatPrompt } from './csat-prompt'

describe('CsatPrompt', () => {
  it('asks how the resolved ticket went, with one button per star from 1 star to 5 stars', () => {
    render(<CsatPrompt ticketId="ticket-1" />)

    expect(screen.getByText('Your ticket has been resolved. How did it go?')).toBeInTheDocument()
    const stars = screen.getAllByRole('button', { name: /^\d stars?$/ })
    expect(stars.map((star) => star.getAttribute('aria-label'))).toEqual(['1 star', '2 stars', '3 stars', '4 stars', '5 stars'])
  })
})
