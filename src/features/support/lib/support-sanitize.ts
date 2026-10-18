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

// The data attributes that the editor renders: data-type on a task list, a task item and a mention, data-checked on a
// task item, and the ids, labels and trigger character of a mention. Their values are never URLs, but DOMPurify checks
// the value of a listed data attribute as one, which would remove a label such as "QA: Ayşe", so they are URI safe too.
const DATA_ATTR = [
  'data-type', 'data-checked',
  'data-id', 'data-label', 'data-mention-suggestion-char', 'data-mention-id', 'data-mention-label',
]

const ALLOWED_ATTR = [
  'href', 'target', 'rel',
  'src', 'alt', 'width', 'height',
  'class',
  ...DATA_ATTR,
]

// Attributes that the editor renders on one tag only, allowed on that tag alone
const TAG_ATTR = new Map<string, readonly string[]>([
  ['input', ['type', 'checked']], // the task item checkbox
  ['ol', ['start']], // an ordered list typed as "3. " starts at 3
])

// The classes that the editor renders, each on its one tag: the mention chip, and the language of a code block typed
// as "```sql" or pasted with one, such as language-c++
const TAG_CLASS = new Map<string, RegExp>([
  ['SPAN', /^mention-chip$/],
  ['CODE', /^language-\S+$/],
])

const ATTACHMENT_URL_PREFIX = '/support/api/attachments/'

// The checks run on the final attributes of each element. The only input the editor renders is the task item checkbox,
// and an input whose type was removed would render as a text field. The only images it inserts come from the
// attachment route; checking the src on the node instead of the serialized HTML also catches an img whose alt holds
// a >, which serialization leaves unescaped. A class stays only as the editor renders it, so ticket HTML cannot use any
// other class of the app's stylesheet.
function removeUnlessEditorOutput(element: Element): void {
  if (element.nodeName === 'INPUT' && element.getAttribute('type') !== 'checkbox') element.remove()
  if (element.nodeName === 'IMG' && !(element.getAttribute('src') ?? '').startsWith(ATTACHMENT_URL_PREFIX)) {
    element.remove()
  }
  const className = element.getAttribute('class')
  if (className !== null && !TAG_CLASS.get(element.nodeName)?.test(className)) element.removeAttribute('class')
}

export function sanitizeTicketHtml(html: string): string {
  // DOMPurify keeps its hooks on one shared instance, so this hook is in place for this call only.
  DOMPurify.addHook('afterSanitizeAttributes', removeUnlessEditorOutput)
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ADD_ATTR: (attr, tag) => TAG_ATTR.get(tag)?.includes(attr) ?? false,
      ADD_URI_SAFE_ATTR: DATA_ATTR,
      // DOMPurify allows every data and aria attribute before it reads ALLOWED_ATTR, unless these are false.
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      FORBID_TAGS: ['svg', 'math', 'style', 'script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['style'],
    })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', removeUnlessEditorOutput)
  }
}
