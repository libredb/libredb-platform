'use client'

import parse from 'html-react-parser'
import { sanitizeTicketHtml } from '@/features/support/lib/support-sanitize'

/**
 * Renders stored Tiptap HTML as React elements. Content is sanitized on write
 * (send-message action uses sanitizeTicketHtml) AND re-sanitized here, then
 * parsed into React via html-react-parser. The DOM is never written to directly.
 */
interface SanitizedHtmlProps {
  html: string
  className?: string
}

export function SanitizedHtml({ html, className }: SanitizedHtmlProps) {
  const safe = sanitizeTicketHtml(html)
  return <div className={className}>{parse(safe)}</div>
}
