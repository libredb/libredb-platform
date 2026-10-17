import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// The Server Action reaches the database, and rendering the prompt never calls it.
const { submitCsat } = vi.hoisted(() => ({ submitCsat: vi.fn() }))
vi.mock('../actions/submit-csat', () => ({ submitCsat }))

import { CsatPrompt } from './csat-prompt'

describe('CsatPrompt', () => {
  it('asks how the resolved ticket went, with one button per star from 1 star to 5 stars', () => {
    render(<CsatPrompt ticketId="ticket-1" />)

    expect(screen.getByText('Your ticket has been resolved. How did it go?')).toBeInTheDocument()
    const stars = screen.getAllByRole('button', { name: /^\d stars?$/ })
    expect(stars.map((star) => star.getAttribute('aria-label'))).toEqual(['1 star', '2 stars', '3 stars', '4 stars', '5 stars'])
  })

  it('thanks the customer for a sent rating with a hidden check icon and no check mark character', async () => {
    submitCsat.mockResolvedValue({ success: true, data: undefined })
    render(<CsatPrompt ticketId="ticket-1" />)

    fireEvent.click(screen.getByRole('button', { name: '5 stars' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const thanks = await screen.findByText(/Thank you for your rating\./)
    expect(thanks.textContent?.trim()).toBe('Thank you for your rating.')
    expect(thanks.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
