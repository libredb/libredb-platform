import { describe, it, expect } from 'vitest'
import { sanitizeTicketHtml } from './support-sanitize'

describe('sanitizeTicketHtml', () => {
  it('strips <script>', () => {
    const out = sanitizeTicketHtml('<p>hi</p><script>alert(1)</script>')
    expect(out).toContain('<p>hi</p>')
    expect(out).not.toContain('script')
  })

  it('strips inline event handlers', () => {
    const out = sanitizeTicketHtml('<p onclick="alert(1)">hi</p>')
    expect(out).toContain('<p>hi</p>')
    expect(out).not.toContain('onclick')
  })

  it('strips javascript: URLs', () => {
    const out = sanitizeTicketHtml('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
  })

  it('rejects SVG', () => {
    const out = sanitizeTicketHtml('<svg><script>alert(1)</script></svg>')
    expect(out).not.toContain('<svg')
    expect(out).not.toContain('script')
  })

  it('keeps mention chip span', () => {
    const out = sanitizeTicketHtml('<span data-mention-id="u1" class="mention-chip">@Name</span>')
    expect(out).toContain('data-mention-id="u1"')
    expect(out).toContain('mention-chip')
  })

  it('keeps attachment route images', () => {
    const out = sanitizeTicketHtml('<img src="/support/api/attachments/a1/download" alt="x">')
    expect(out).toContain('/support/api/attachments/a1/download')
  })

  it('strips external images', () => {
    const out = sanitizeTicketHtml('<img src="https://evil.example/pix.png">')
    expect(out).not.toContain('evil.example')
  })

  it('keeps code and pre', () => {
    const out = sanitizeTicketHtml('<pre><code>SELECT 1</code></pre>')
    expect(out).toContain('<pre>')
    expect(out).toContain('<code>')
    expect(out).toContain('SELECT 1')
  })
})
