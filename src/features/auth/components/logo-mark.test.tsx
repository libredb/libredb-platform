import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LogoMark } from './logo-mark'

describe('LogoMark', () => {
  it('renders brand text and platform label', () => {
    render(<LogoMark />)
    expect(screen.getByText('LibreDB')).toBeInTheDocument()
    expect(screen.getByText('Platform')).toBeInTheDocument()
  })

  it('includes a pulsing health dot marked aria-hidden', () => {
    render(<LogoMark />)
    const dot = document.querySelector('[data-testid="logo-health-dot"]')
    expect(dot).toBeTruthy()
    expect(dot?.getAttribute('aria-hidden')).toBe('true')
  })
})
