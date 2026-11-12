export type EditInput = { text?: string; color?: string; background?: string; opacity?: string; fontFamily?: string }
export type EditDiff = {
  text?: { from: string; to: string }; color?: { from: string; to: string }
  background?: { from: string; to: string }; opacity?: { from: string; to: string }; fontFamily?: { from: string; to: string }
}

function isTextFormControl(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

/** Form controls keep their text in value and textContent is always empty; reading textContent would leave the text field blank for inputs. */
export function readElementText(el: HTMLElement): string {
  return isTextFormControl(el) ? el.value : el.textContent ?? ''
}

export function writeElementText(el: HTMLElement, text: string): void {
  if (isTextFormControl(el)) el.value = text
  else el.textContent = text
}

/** Editing text flattens the subtree into plain text, so it is only offered for form controls and elements without element children. */
export function canEditText(el: HTMLElement): boolean {
  return isTextFormControl(el) || el.children.length === 0
}

export function applyEdit(el: HTMLElement, input: EditInput): EditDiff {
  const cs = window.getComputedStyle(el)
  const diff: EditDiff = {}
  if (input.text != null) {
    const from = readElementText(el)
    if (input.text !== from) { diff.text = { from, to: input.text }; writeElementText(el, input.text) }
  }
  if (input.color) { diff.color = { from: cs.color, to: input.color }; el.style.color = input.color }
  if (input.background) { diff.background = { from: cs.backgroundColor, to: input.background }; el.style.background = input.background }
  // '0' is a valid, meaningful opacity and must not be swallowed by a falsy check
  if (input.opacity != null && input.opacity !== '') { diff.opacity = { from: cs.opacity, to: input.opacity }; el.style.opacity = input.opacity }
  if (input.fontFamily) { diff.fontFamily = { from: cs.fontFamily, to: input.fontFamily }; el.style.fontFamily = input.fontFamily }
  return diff
}
