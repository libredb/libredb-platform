import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GovernanceTopology } from './governance-topology'
import { demoRoles, demoConnections } from '../lib/hero-demo-data'

describe('GovernanceTopology', () => {
  it('renders every tenant-level role name (admin/editor/viewer)', () => {
    render(<GovernanceTopology />)
    for (const r of demoRoles) {
      expect(screen.getByText(r.name)).toBeInTheDocument()
    }
  })

  it('renders every demo connection name', () => {
    render(<GovernanceTopology />)
    for (const c of demoConnections) {
      expect(screen.getByText(c.name)).toBeInTheDocument()
    }
  })

  it('does NOT render cross-tenant names (would imply shared data)', () => {
    render(<GovernanceTopology />)
    // Guard against regressing to the original (wrong) demo tenant list.
    expect(screen.queryByText(/Acme Corp/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Finch Labs/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Orbit Inc/i)).not.toBeInTheDocument()
  })

  it('shows the central Governance Layer label', () => {
    render(<GovernanceTopology />)
    expect(screen.getByText(/GOVERNANCE LAYER/i)).toBeInTheDocument()
  })

  it('marks decorative SVG as aria-hidden', () => {
    render(<GovernanceTopology />)
    const svgs = document.querySelectorAll('svg[aria-hidden="true"]')
    expect(svgs.length).toBeGreaterThan(0)
  })
})
