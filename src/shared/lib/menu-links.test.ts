import { describe, it, expect } from 'vitest'
import { resolveMenuLinks } from './menu-links'
import { ConfigError } from './errors'
import type { MenuItem } from './menu'

function item(code: string, url: string | null, children: MenuItem[] = []): MenuItem {
  return {
    id: code.toLowerCase(),
    code,
    name: code,
    url,
    icon: null,
    sortOrder: 0,
    level: 0,
    parentId: null,
    external: false,
    children,
  }
}

describe('resolveMenuLinks', () => {
  it('resolves STUDIO to STUDIO_PUBLIC_URL as an external link', () => {
    const items = [item('STUDIO', null), item('CONNECTIONS', '/connections')]

    const resolved = resolveMenuLinks(items, { STUDIO_PUBLIC_URL: 'https://studio.example.test' })

    expect(resolved).toEqual([
      { ...item('STUDIO', null), url: 'https://studio.example.test', external: true },
      item('CONNECTIONS', '/connections'),
    ])
  })

  it('omits STUDIO when STUDIO_PUBLIC_URL is unset', () => {
    const items = [item('STUDIO', null), item('CONNECTIONS', '/connections')]

    expect(resolveMenuLinks(items, {})).toEqual([item('CONNECTIONS', '/connections')])
    expect(resolveMenuLinks(items, { STUDIO_PUBLIC_URL: '' })).toEqual([item('CONNECTIONS', '/connections')])
  })

  it('throws ConfigError naming STUDIO_PUBLIC_URL for a value that is not an absolute http(s) URL', () => {
    const items = [item('STUDIO', null)]

    for (const value of ['studio.example.test', '/studio', 'ftp://studio.example.test', 'javascript:alert(1)']) {
      expect(() => resolveMenuLinks(items, { STUDIO_PUBLIC_URL: value })).toThrow(ConfigError)
      expect(() => resolveMenuLinks(items, { STUDIO_PUBLIC_URL: value })).toThrow(/STUDIO_PUBLIC_URL/)
    }
  })

  it('resolves STUDIO inside a parent and leaves other items untouched', () => {
    const items = [item('ADMIN', '/admin', [item('STUDIO', null), item('ADMIN_USERS', '/admin/users')])]

    const resolved = resolveMenuLinks(items, { STUDIO_PUBLIC_URL: 'http://studio.local:3001/' })

    expect(resolved[0].children).toEqual([
      { ...item('STUDIO', null), url: 'http://studio.local:3001/', external: true },
      item('ADMIN_USERS', '/admin/users'),
    ])
  })
})
