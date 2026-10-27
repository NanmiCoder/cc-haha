/**
 * Test helpers for driving the ProseMirror composer (MentionComposer) in
 * jsdom. `fireEvent.change` cannot type into a contenteditable editor, so
 * tests set the text by dispatching a transaction on the live EditorView —
 * the same code path real typing takes (dispatchTransaction → onChange →
 * parent state), just without simulating raw DOM mutations.
 */
import { act } from 'react'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { getComposerViewForTesting } from './MentionComposer'
import { projectComposerDoc, textOffsetToPmPos } from './composerEditor'

export function getComposerElement(): HTMLElement {
  const element = document.querySelector('[data-composer-editor]')
  if (!element) throw new Error('composer editor element not found')
  return element as HTMLElement
}

export function getComposerView(): EditorView {
  const view = getComposerViewForTesting(getComposerElement())
  if (!view) throw new Error('composer view not found — is a MentionComposer mounted?')
  return view
}

/** Replace the whole composer content, optionally placing the caret at a projected offset. */
export function setComposerText(text: string, selectionOffset?: number): void {
  const view = getComposerView()
  act(() => {
    // Insert and place the caret in one transaction, so the component's
    // onChange (trigger detection for / and @) sees the final caret position.
    const tr = view.state.tr.insertText(text, 0, view.state.doc.content.size)
    if (selectionOffset !== undefined) {
      const pos = textOffsetToPmPos(tr.doc, selectionOffset)
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos)))
    }
    view.dispatch(tr)
  })
}

/** Current projected plain-text content of the composer. */
export function getComposerText(): string {
  return projectComposerDoc(getComposerView().state.doc).text
}

/** Place the caret at a projected text offset. */
export function setComposerSelection(offset: number): void {
  const view = getComposerView()
  act(() => {
    const pos = textOffsetToPmPos(view.state.doc, offset)
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))))
  })
}

/**
 * jsdom has no Range geometry, which ProseMirror reads whenever a transaction
 * scrolls the selection into view. Returns the function that puts it back.
 */
export function stubRangeGeometry(): () => void {
  const clientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
  const boundingRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) }),
    },
  })
  return () => {
    for (const [name, original] of [['getClientRects', clientRects], ['getBoundingClientRect', boundingRect]] as const) {
      if (original) Object.defineProperty(Range.prototype, name, original)
      else Reflect.deleteProperty(Range.prototype, name)
    }
  }
}
