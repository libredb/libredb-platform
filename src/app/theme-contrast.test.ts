import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

// The theme tokens of globals.css, so a token change that drops text under the 4.5:1 contrast of WCAG AA in either
// theme fails here first instead of in a browser.
const css = readFileSync(join(__dirname, 'globals.css'), 'utf8')

function themeTokens(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) throw new Error(`globals.css has no ${selector} block`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return new Map([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
}

// WCAG relative luminance of an opaque oklch() colour: OKLab to linear sRGB, clipped to the sRGB gamut.
function luminance(colour: string): number {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(colour)
  if (!match) throw new Error(`not an opaque oklch() colour: ${colour}`)
  const [lightness, chroma, hue] = match.slice(1).map(Number)
  const a = chroma * Math.cos((hue * Math.PI) / 180)
  const b = chroma * Math.sin((hue * Math.PI) / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clip = (value: number) => Math.min(1, Math.max(0, value))
  const red = clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
  const green = clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
  const blue = clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

// Each text token with every surface the components put it on.
const PAIRS: [text: string, surface: string][] = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'popover'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'accent'],
  ['muted-foreground', 'sidebar'],
  ['muted-foreground', 'sidebar-accent'],
]

describe.each([
  ['light', ':root'],
  ['dark', '.dark'],
])('the %s theme of globals.css', (_theme, selector) => {
  const tokens = themeTokens(selector)

  it.each(PAIRS)('keeps --%s on --%s at 4.5:1 or more', (text, surface) => {
    const ratio = contrast(tokens.get(text) ?? '', tokens.get(surface) ?? '')
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
})
