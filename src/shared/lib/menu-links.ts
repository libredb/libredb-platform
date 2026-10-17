import { ConfigError } from './errors'
import type { MenuItem } from './menu'
import { isAbsoluteHttpUrl, type RuntimeConfig } from './runtime-config'

/** The variables of the validated runtime configuration (`getRuntimeConfig()`) that menu links read. */
export type MenuLinkConfig = Partial<Pick<RuntimeConfig, 'STUDIO_PUBLIC_URL'>>

// Menu codes whose target lives outside Platform, keyed to the variable holding the URL.
const EXTERNAL_LINKS = {
  STUDIO: 'STUDIO_PUBLIC_URL',
} as const satisfies Record<string, keyof MenuLinkConfig>

function readExternalUrl(variable: keyof MenuLinkConfig, config: MenuLinkConfig): string | null {
  const value = config[variable]
  if (value === undefined || value === '') return null
  // getRuntimeConfig() has already checked the value; this guards any other caller.
  if (!isAbsoluteHttpUrl(value)) {
    throw new ConfigError(`${variable} must be an absolute http(s) URL`)
  }
  return value
}

/**
 * Resolves menu items that link outside Platform from the validated runtime configuration.
 * An external item whose variable is unset is omitted; an invalid value throws ConfigError.
 */
export function resolveMenuLinks(items: MenuItem[], config: MenuLinkConfig): MenuItem[] {
  const resolved: MenuItem[] = []
  for (const item of items) {
    const children = resolveMenuLinks(item.children, config)
    const variable = EXTERNAL_LINKS[item.code as keyof typeof EXTERNAL_LINKS]
    if (!variable) {
      resolved.push({ ...item, children })
      continue
    }
    const url = readExternalUrl(variable, config)
    if (url === null) continue
    resolved.push({ ...item, url, external: true, children })
  }
  return resolved
}
