import { afterEach, describe, expect, it } from 'vitest'
import { isFromInteractiveControl } from './hotkeys'

/** What isFromInteractiveControl says of the key e pressed on `target`, read where the hotkeys listen: on the document. */
function ignoresKeyOn(target: Element): boolean {
  let ignored: boolean | undefined
  const listener = (event: KeyboardEvent) => { ignored = isFromInteractiveControl(event) }
  document.addEventListener('keydown', listener)
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true }))
  document.removeEventListener('keydown', listener)
  if (ignored === undefined) throw new Error('the keydown never reached the document')
  return ignored
}

/** Renders `html` into the page and returns the element marked data-target, or the body when none is. */
function targetIn(html: string): Element {
  document.body.innerHTML = html
  return document.querySelector('[data-target]') ?? document.body
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isFromInteractiveControl', () => {
  it.each([
    ['an input', '<input data-target>'],
    ['a textarea', '<textarea data-target></textarea>'],
    ['a native select', '<select data-target><option>Low</option></select>'],
    ['text inside an editable region, such as the reply editor', '<div contenteditable="true"><p data-target>Hello</p></div>'],
    ['a button', '<button data-target>Reply</button>'],
    ['an element with role button', '<div role="button" tabindex="0" data-target>Reply</div>'],
    ['a select trigger, a button with role combobox', '<button role="combobox" aria-expanded="false" data-target>Medium</button>'],
    ['a listbox', '<div role="listbox" tabindex="0" data-target></div>'],
    ['an option', '<div role="listbox"><div role="option" tabindex="-1" data-target>High</div></div>'],
    ['a menu', '<div role="menu" tabindex="-1" data-target></div>'],
    ['a menu item', '<div role="menu"><div role="menuitem" tabindex="-1" data-target>Merge</div></div>'],
    ['a checkable menu item', '<div role="menu"><div role="menuitemcheckbox" tabindex="-1" data-target>Muted</div></div>'],
    ['an element with role textbox', '<div role="textbox" tabindex="0" data-target></div>'],
    ['an element with role searchbox', '<div role="searchbox" tabindex="0" data-target></div>'],
    ['the inside of an open dialog', '<div role="dialog" tabindex="-1"><dl><dt data-target>j / k</dt></dl></div>'],
    ['the inside of an open alert dialog', '<div role="alertdialog" tabindex="-1"><p data-target>Delete?</p></div>'],
  ])('ignores a key typed on %s', (_kind, html) => {
    expect(ignoresKeyOn(targetIn(html))).toBe(true)
  })

  it.each([
    ['the page body, where nothing has focus', '<main><p>Ticket</p></main>'],
    ['an inbox row, a link', '<section><a href="/support/ticket-1" data-target>TKT-0001 Database unreachable</a></section>'],
    ['a focusable region that is no control', '<div tabindex="0" data-target><p>Timeline</p></div>'],
    ['a region whose editing is switched off', '<div contenteditable="false" tabindex="0" data-target>Read only</div>'],
  ])('keeps a key typed on %s', (_kind, html) => {
    expect(ignoresKeyOn(targetIn(html))).toBe(false)
  })
})
