// The controls that handle keys themselves: a text field types them, a select, a list or a menu opens, moves or chooses
// with them, and a button presses on Enter. Every key typed inside an open dialog, listbox or menu belongs to that popup.
const INTERACTIVE_CONTROL = [
  'input', 'textarea', 'select', 'button',
  ...['button', 'combobox', 'listbox', 'option', 'menu', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'textbox',
    'searchbox', 'dialog', 'alertdialog'].map((role) => `[role="${role}"]`),
].join(', ')

/**
 * Whether a key event comes from a control that handles keys itself, or from inside an open popup, so that a hotkey of
 * the support pages must leave the key to it. Passed as `ignoreEventWhen` to every useHotkeys of those pages, because
 * react-hotkeys-hook skips only form fields, editable regions and a few roles on its own: a focused select trigger, a
 * button with role combobox, took e as Resolve and Enter as opening the highlighted inbox ticket.
 */
export function isFromInteractiveControl(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.closest(INTERACTIVE_CONTROL) !== null
}
