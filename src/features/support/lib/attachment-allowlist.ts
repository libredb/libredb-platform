export const MAX_FILE_BYTES = 25 * 1024 * 1024        // 25 MB
export const MAX_TICKET_BYTES = 100 * 1024 * 1024     // 100 MB
export const MAX_FILES_PER_MESSAGE = 10

const ALLOWED_MIME_PREFIXES = ['image/']
const ALLOWED_MIME_EXACT = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'application/x-log',
  'application/octet-stream',
])
const BLOCKED_MIME = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/javascript',
  'application/x-msdownload',
  'application/x-executable',
])
const ALLOWED_EXT = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff',
  'pdf',
  'txt', 'log', 'sql', 'md', 'csv', 'json', 'har',
  'zip',
])
const DENIED_EXT = new Set([
  'exe', 'dll', 'sh', 'bat', 'cmd', 'ps1',
  'js', 'mjs', 'cjs',
  'html', 'htm', 'xhtml', 'svg',
  'jsp', 'asp', 'aspx', 'php',
  'msi', 'app', 'dmg',
])

export function isAllowedMime(mime: string): boolean {
  const lower = mime.toLowerCase()
  if (BLOCKED_MIME.has(lower)) return false
  if (ALLOWED_MIME_PREFIXES.some(p => lower.startsWith(p))) {
    return lower !== 'image/svg+xml'
  }
  return ALLOWED_MIME_EXACT.has(lower)
}

function extOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.')
  if (idx === -1) return ''
  return fileName.slice(idx + 1).toLowerCase()
}

export function isAllowedExtension(fileName: string): boolean {
  const ext = extOf(fileName)
  return ALLOWED_EXT.has(ext)
}

export function isDeniedExtension(fileName: string): boolean {
  return DENIED_EXT.has(extOf(fileName))
}
