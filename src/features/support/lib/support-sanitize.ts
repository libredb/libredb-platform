import DOMPurify from 'isomorphic-dompurify'

const ALLOWED_TAGS = [
  'p', 'br', 'hr',
  'strong', 'em', 's', 'u',
  'a',
  'code', 'pre',
  'ul', 'ol', 'li',
  'blockquote',
  'img',
  'span',
]

const ALLOWED_ATTR = [
  'href', 'target', 'rel',
  'src', 'alt', 'width', 'height',
  'class',
  'data-mention-id', 'data-mention-label',
  'data-type', 'data-checked',
]

const ATTACHMENT_URL_PREFIX = '/support/api/attachments/'

export function sanitizeTicketHtml(html: string): string {
  const firstPass = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ['svg', 'math', 'style', 'script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style'],
    USE_PROFILES: { html: true },
  })
  // Second pass: drop any <img> whose src is not the attachment route
  return firstPass.replace(
    /<img\s[^>]*src="([^"]*)"[^>]*>/g,
    (match, src: string) => (src.startsWith(ATTACHMENT_URL_PREFIX) ? match : ''),
  )
}
