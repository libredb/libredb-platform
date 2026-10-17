import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HeroTitle } from './hero-title'

describe('HeroTitle', () => {
  it('renders the kicker text', () => {
    render(<HeroTitle />)
    expect(screen.getByText(/Database Access Governance/i)).toBeInTheDocument()
  })

  it('renders three headline words with periods', () => {
    render(<HeroTitle />)
    expect(screen.getByText('Authorize.')).toBeInTheDocument()
    expect(screen.getByText('Audit.')).toBeInTheDocument()
    expect(screen.getByText('Govern.')).toBeInTheDocument()
  })

  it('renders the Govern word with the gradient animation class', () => {
    render(<HeroTitle />)
    const govern = screen.getByText('Govern.')
    expect(govern.className).toMatch(/animate-govern-gradient/)
  })
})
