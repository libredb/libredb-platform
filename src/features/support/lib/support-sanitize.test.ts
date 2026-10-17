import { describe, it, expect } from 'vitest'
import DOMPurify from 'isomorphic-dompurify'
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

  it('strips an external image whose alt holds a >, which serialized HTML leaves unescaped', () => {
    const out = sanitizeTicketHtml('<p>x</p><img alt="a>b" src="https://evil.example/pix.png">')
    expect(out).toBe('<p>x</p>')
  })

  it('keeps code and pre', () => {
    const out = sanitizeTicketHtml('<pre><code>SELECT 1</code></pre>')
    expect(out).toContain('<pre>')
    expect(out).toContain('<code>')
    expect(out).toContain('SELECT 1')
  })

  it.each([
    ['h1', '<h1>Session expired</h1>', 'Session expired'],
    ['table', '<table><tbody><tr><td>cell</td></tr></tbody></table>', 'cell'],
    ['button', '<button type="button">Confirm</button>', 'Confirm'],
    ['select', '<select name="s"><option>a</option></select>', 'a'],
    ['textarea', '<textarea name="t">x</textarea>', 'x'],
  ])('strips <%s> and keeps its text', (_tag, html, text) => {
    const out = sanitizeTicketHtml(html)
    expect(out).toBe(text)
  })

  it.each([
    ['type="password"', '<p>Password: <input type="password" name="password"></p>'],
    ['type="text"', '<p>Password: <input type="text" name="password"></p>'],
    ['without a type, which renders as text', '<p>Password: <input name="password"></p>'],
    ['with an unknown type, which renders as text', '<p>Password: <input type="checkboxes"></p>'],
  ])('strips <input> %s', (_input, html) => {
    const out = sanitizeTicketHtml(html)
    expect(out).toBe('<p>Password: </p>')
  })

  it('strips a password input in place of a task item checkbox', () => {
    const out = sanitizeTicketHtml(
      '<ul data-type="taskList"><li data-type="taskItem"><label><input type="password"><span></span></label><div><p>x</p></div></li></ul>',
    )
    expect(out).toBe(
      '<ul data-type="taskList"><li data-type="taskItem"><label><span></span></label><div><p>x</p></div></li></ul>',
    )
  })

  it('leaves its input and image rules off the shared DOMPurify instance', () => {
    sanitizeTicketHtml('<p>hi</p>')
    expect(DOMPurify.sanitize('<input type="text">')).toBe('<input type="text">')
    expect(DOMPurify.sanitize('<img src="https://example.com/a.png">')).toBe('<img src="https://example.com/a.png">')
  })

  it('keeps only the type and checked state of a task item checkbox', () => {
    const out = sanitizeTicketHtml('<label><input type="checkbox" checked="checked" name="agree" value="yes" form="f"></label>')
    expect(out).toBe('<label><input type="checkbox" checked="checked"></label>')
  })

  it('strips attributes outside the allowlist', () => {
    const out = sanitizeTicketHtml('<p id="notice" name="notice">hi</p>')
    expect(out).toBe('<p>hi</p>')
  })

  it('strips srcset, which would load an attachment image from another origin', () => {
    const out = sanitizeTicketHtml('<img src="/support/api/attachments/a1/download" srcset="https://evil.example/pix.png 2x">')
    expect(out).toBe('<img src="/support/api/attachments/a1/download">')
  })
})
