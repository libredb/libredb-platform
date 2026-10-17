import { describe, it, expect } from 'vitest'
import {
  demoRoles,
  demoConnections,
  supportedEngines,
  engineChip,
  type DemoRole,
  type DemoConnection,
  type SupportedEngine,
} from './hero-demo-data'

describe('hero-demo-data', () => {
  it('exports exactly 3 tenant-level roles (admin/editor/viewer)', () => {
    expect(demoRoles).toHaveLength(3)
    const keys = demoRoles.map((r) => r.key)
    expect(keys).toEqual(['admin', 'editor', 'viewer'])
    for (const r of demoRoles) {
      expect(r).toMatchObject<DemoRole>({
        name: expect.any(String),
        key: expect.stringMatching(/^(admin|editor|viewer)$/),
        access: expect.any(String),
      })
    }
  })

  it('exports exactly 4 demo connections with non-empty names', () => {
    expect(demoConnections).toHaveLength(4)
    for (const c of demoConnections) {
      expect(c).toMatchObject<DemoConnection>({
        name: expect.any(String),
        engine: expect.any(String),
        status: expect.stringMatching(/^(healthy|warning|slow)$/),
      })
      expect(c.name.length).toBeGreaterThan(0)
    }
  })

  it('exports the full list of 7 supported engines with brand colors', () => {
    expect(supportedEngines).toHaveLength(7)
    const engines = supportedEngines.map((e) => e.engine)
    expect(engines).toEqual(
      expect.arrayContaining([
        'postgres', 'mysql', 'oracle', 'mssql', 'sqlite', 'mongodb', 'redis',
      ]),
    )
    for (const e of supportedEngines) {
      expect(e).toMatchObject<SupportedEngine>({
        engine: expect.any(String),
        label: expect.any(String),
        chip: expect.stringMatching(/^[A-Z][a-zA-Z]$/),
        color: expect.stringMatching(/^#[0-9A-F]{6}$/i),
      })
    }
  })

  it('engineChip returns the chip from supportedEngines for each engine', () => {
    for (const e of supportedEngines) {
      expect(engineChip(e.engine)).toBe(e.chip)
    }
  })
})
