import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DirectoryDegradedBanner } from './directory-degraded-banner'

describe('DirectoryDegradedBanner', () => {
  it('renders only while directoryDegraded is true', () => {
    const { container, rerender } = render(<DirectoryDegradedBanner directoryDegraded />)

    expect(screen.getByRole('status')).toHaveTextContent('Keycloak is unreachable')
    expect(screen.getByRole('status')).toHaveTextContent('Actions that need the Keycloak directory are disabled')

    rerender(<DirectoryDegradedBanner directoryDegraded={false} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })
})
