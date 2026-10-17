import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('../actions/update-studio-setting', () => ({ updateStudioSetting: vi.fn() }))
vi.mock('../actions/reset-studio-setting', () => ({ resetStudioSetting: vi.fn() }))

import { StudioSettingsForm } from './studio-settings-form'
import type { StudioSettingField } from '../lib/setting-value'

function field(overrides: Partial<StudioSettingField> & Pick<StudioSettingField, 'key' | 'valueType'>): StudioSettingField {
  return {
    description: `${overrides.key} description`,
    allowedValues: null,
    minValue: null,
    maxValue: null,
    value: null,
    updatedAt: null,
    held: false,
    ...overrides,
  }
}

function rowOf(key: string): HTMLElement {
  return screen.getByRole('group', { name: key })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('StudioSettingsForm', () => {
  it('shows Studio default for keys without a value', () => {
    render(
      <StudioSettingsForm
        settings={[
          field({ key: 'query.timeoutMs', valueType: 'integer', minValue: 1000, maxValue: 3600000 }),
          field({
            key: 'queryLog.statementCapture',
            valueType: 'string',
            allowedValues: ['none', 'redacted', 'full'],
            value: 'redacted',
            updatedAt: '2026-10-15T09:00:00.000Z',
          }),
        ]}
      />,
    )

    expect(within(rowOf('query.timeoutMs')).getByTestId('current-value').textContent).toBe('Studio default')
    expect(within(rowOf('query.timeoutMs')).queryByRole('button', { name: 'Reset query.timeoutMs' })).toBeNull()
    expect(within(rowOf('queryLog.statementCapture')).queryByText('Studio default')).toBeNull()
    expect(within(rowOf('queryLog.statementCapture')).getByTestId('current-value').textContent).toBe('redacted')
    expect(within(rowOf('queryLog.statementCapture')).getByRole('button', { name: 'Reset queryLog.statementCapture' })).toBeTruthy()
  })

  it('renders a control for a key the code does not know, from its allowlist row', () => {
    render(
      <StudioSettingsForm
        settings={[
          field({ key: 'export.maxRows', valueType: 'integer', minValue: 10, maxValue: 500 }),
          field({ key: 'export.enabled', valueType: 'boolean' }),
          field({ key: 'export.format', valueType: 'string', allowedValues: ['csv', 'json'] }),
          field({ key: 'export.banner', valueType: 'string' }),
        ]}
      />,
    )

    const maxRows = within(rowOf('export.maxRows')).getByRole('spinbutton', { name: 'export.maxRows' })
    expect(maxRows.getAttribute('min')).toBe('10')
    expect(maxRows.getAttribute('max')).toBe('500')
    expect(within(rowOf('export.enabled')).getByRole('switch', { name: 'export.enabled' })).toBeTruthy()
    expect(within(rowOf('export.format')).getByRole('combobox', { name: 'export.format' })).toBeTruthy()
    expect(within(rowOf('export.banner')).getByRole('textbox', { name: 'export.banner' })).toBeTruthy()
    for (const key of ['export.maxRows', 'export.enabled', 'export.format', 'export.banner']) {
      expect(within(rowOf(key)).getByText(`${key} description`)).toBeTruthy()
      expect(within(rowOf(key)).getByRole('button', { name: `Save ${key}` })).toBeTruthy()
    }
  })

  it('held keys render read-only with the hold note', () => {
    render(
      <StudioSettingsForm
        settings={[
          field({ key: 'agent.enabled', valueType: 'boolean', held: true }),
          field({ key: 'mcp.enabled', valueType: 'boolean', held: true }),
        ]}
      />,
    )

    for (const key of ['agent.enabled', 'mcp.enabled']) {
      const row = rowOf(key)
      const control = within(row).getByRole('switch', { name: key })
      expect(control.getAttribute('aria-disabled') === 'true' || control.hasAttribute('data-disabled')).toBe(true)
      expect(within(row).getByText('Held off in governance mode until MCP and agent governance ship.')).toBeTruthy()
      expect(within(row).queryByRole('button', { name: `Save ${key}` })).toBeNull()
      expect(within(row).queryByRole('button', { name: `Reset ${key}` })).toBeNull()
    }
  })
})
