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
  // A task item renders <label><input type="checkbox"><span></span></label><div>...</div>
  'label', 'input', 'div',
]

const ALLOWED_ATTR = [
  'href', 'target', 'rel',
  'src', 'alt', 'width', 'height',
  'class',
  'data-mention-id', 'data-mention-label',
  'data-type', 'data-checked',
]

// Attributes that the editor renders on one tag only, allowed on that tag alone
const TAG_ATTR = new Map<string, readonly string[]>([
  ['input', ['type', 'checked']], // the task item checkbox
  ['ol', ['start']], // an ordered list typed as "3. " starts at 3
])

const ATTACHMENT_URL_PREFIX = '/support/api/attachments/'

// The checks run on the final attributes of each element. The only input the editor renders is the task item checkbox,
// and an input whose type was removed would render as a text field. The only images it inserts come from the
// attachment route; checking the src on the node instead of the serialized HTML also catches an img whose alt holds
// a >, which serialization leaves unescaped.
function removeUnlessEditorOutput(element: Element): void {
  if (element.nodeName === 'INPUT' && element.getAttribute('type') !== 'checkbox') element.remove()
  if (element.nodeName === 'IMG' && !(element.getAttribute('src') ?? '').startsWith(ATTACHMENT_URL_PREFIX)) {
    element.remove()
  }
}

export function sanitizeTicketHtml(html: string): string {
  // DOMPurify keeps its hooks on one shared instance, so this hook is in place for this call only.
  DOMPurify.addHook('afterSanitizeAttributes', removeUnlessEditorOutput)
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ADD_ATTR: (attr, tag) => TAG_ATTR.get(tag)?.includes(attr) ?? false,
      FORBID_TAGS: ['svg', 'math', 'style', 'script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['style'],
    })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', removeUnlessEditorOutput)
  }
}
