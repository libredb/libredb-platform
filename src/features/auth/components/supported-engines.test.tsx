import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SupportedEngines } from './supported-engines'
import { supportedEngines } from '../lib/hero-demo-data'

describe('SupportedEngines', () => {
  it('renders the section heading with the engine count', () => {
    render(<SupportedEngines />)
    expect(
      screen.getByText(
        new RegExp(`Works Across Your Stack · ${supportedEngines.length} Engines`, 'i'),
      ),
    ).toBeInTheDocument()
  })

  it('renders every supported engine label', () => {
    render(<SupportedEngines />)
    for (const e of supportedEngines) {
      expect(screen.getByText(e.label)).toBeInTheDocument()
    }
  })

  it('renders decorative engine chips marked aria-hidden', () => {
    const { container } = render(<SupportedEngines />)
    const chips = container.querySelectorAll('span[aria-hidden="true"]')
    // One chip per engine + the ruler line at the top
    expect(chips.length).toBeGreaterThanOrEqual(supportedEngines.length)
  })
})
