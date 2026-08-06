/**
 * ProseMirror-backed composer editor.
 *
 * Replaces the plain <textarea> so @-mentions can render as inline pills
 * (atom nodes) while everything upstream still speaks plain text: the parent
 * owns a projected `value` string plus the `mentions` array, and this
 * component keeps the PM document in sync with both directions.
 *
 *  - User edits flow out through `onChange(projectedText, mentions)`.
 *  - Programmatic writes flow in through the `value`/`mentions` props; when
 *    they diverge from the last projection the doc is rebuilt (caret kept at
 *    the same projected offset).
 *
 * Keyboard and paste handling are delegated to the parent: `onKeyDown` /
 * `onPaste` return `true` to mark the event handled (same contract as the old
 * textarea handlers calling preventDefault).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { history, redo, undo } from 'prosemirror-history'
import { baseKeymap, splitBlock } from 'prosemirror-commands'
import {
  buildComposerDoc,
  composerSchema,
  deleteAdjacentMentionAtom,
  pmPosToTextOffset,
  projectComposerDoc,
  projectedDocLength,
  serializeComposerDoc,
  textOffsetToPmPos,
} from './composerEditor'
import type { ComposerMention } from '../../lib/composerMentions'
import { mentionsEqual } from '../../lib/composerMentions'

export type MentionComposerHandle = {
  focus: () => void
  /** Caret/selection as offsets in the projected plain text. */
  getSelectionOffsets: () => { start: number; end: number }
  setSelectionOffsets: (start: number, end?: number) => void
  /**
   * Content for the model: text with each mention pill serialized to
   * `@"absolute path"`. Read from the live document, so literal text that
   * merely looks like a pill's token is never rewritten.
   */
  getModelContent: () => string
}

export type MentionComposerProps = {
  value: string
  mentions: ComposerMention[]
  onChange: (text: string, mentions: ComposerMention[]) => void
  onKeyDown?: (event: KeyboardEvent) => boolean
  onPaste?: (event: ClipboardEvent) => boolean
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  placeholder?: string
  disabled?: boolean
  /** Class for the outer wrapper div (layout concerns: flex-1, etc). */
  className?: string
  /** Class for the editable element itself (padding, font size, max-height). */
  editorClassName?: string
  /** Extra aria-* attributes applied to the editable element. */
  aria?: Record<string, string | undefined>
  /** Exposes the wrapper div for outside-press dismissal checks. */
  rootRef?: React.Ref<HTMLDivElement>
}

/**
 * Lets tests reach the live EditorView from the rendered DOM. Keyed by the
 * editable element (`[data-composer-editor]`).
 */
const composerViewRegistry = new WeakMap<HTMLElement, EditorView>()

export function getComposerViewForTesting(element: HTMLElement | null): EditorView | undefined {
  return element ? composerViewRegistry.get(element) : undefined
}

function syncEmptyState(view: EditorView, placeholder?: string) {
  const doc = view.state.doc
  const isEmpty = doc.childCount === 1 && doc.firstChild!.content.size === 0
  if (isEmpty) {
    view.dom.setAttribute('data-empty', 'true')
    view.dom.setAttribute('data-placeholder', placeholder ?? '')
    view.dom.setAttribute('aria-placeholder', placeholder ?? '')
  } else {
    view.dom.removeAttribute('data-empty')
    view.dom.removeAttribute('data-placeholder')
    view.dom.removeAttribute('aria-placeholder')
  }
}

export const MentionComposer = forwardRef<MentionComposerHandle, MentionComposerProps>(
  function MentionComposer(props, ref) {
    const {
      value,
      mentions,
      onCompositionStart,
      onCompositionEnd,
      placeholder,
      className,
      editorClassName,
      aria,
      rootRef,
    } = props

    const containerRef = useRef<HTMLDivElement | null>(null)
    const viewRef = useRef<EditorView | null>(null)
    const propsRef = useRef(props)
    propsRef.current = props
    const lastProjectedRef = useRef({ text: value, mentions })

    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      const view = new EditorView(container, {
        state: EditorState.create({
          schema: composerSchema,
          doc: buildComposerDoc(propsRef.current.value, propsRef.current.mentions),
          plugins: [
            new Plugin({
              key: new PluginKey('mention-composer-props'),
              props: {
                handleKeyDown: (_view, event) => propsRef.current.onKeyDown?.(event) ?? false,
                handlePaste: (_view, event, _slice) => propsRef.current.onPaste?.(event) ?? false,
                handleDOMEvents: {
                  // File drops belong to the composer's outer drop zone, which
                  // turns them into attachments. Left to ProseMirror, a drop
                  // that also carries text (some platforms attach the file
                  // name) would insert that text alongside the attachment.
                  drop: () => true,
                },
              },
            }),
            history(),
            // Whole-pill deletion, ahead of baseKeymap's structural commands.
            keymap({
              'Backspace': deleteAdjacentMentionAtom('backward'),
              'Delete': deleteAdjacentMentionAtom('forward'),
              // Unlike a textarea, ProseMirror does not include Shift+Enter in
              // its base keymap. Keep the composer's configured newline path
              // explicit instead of relying on browser contenteditable behavior.
              'Shift-Enter': splitBlock,
            }),
            keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
            keymap(baseKeymap),
          ],
        }),
        dispatchTransaction: (tr) => {
          const currentView = viewRef.current
          if (!currentView) return
          currentView.updateState(currentView.state.apply(tr))
          if (tr.docChanged) {
            const projected = projectComposerDoc(currentView.state.doc)
            lastProjectedRef.current = projected
            propsRef.current.onChange(projected.text, projected.mentions)
          }
          syncEmptyState(currentView, propsRef.current.placeholder)
        },
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'data-composer-editor': 'true',
          class: 'composer-pm',
        },
        editable: () => !propsRef.current.disabled,
      })

      viewRef.current = view
      composerViewRegistry.set(view.dom, view)
      syncEmptyState(view, propsRef.current.placeholder)

      return () => {
        composerViewRegistry.delete(view.dom)
        viewRef.current = null
        view.destroy()
      }
    }, [])

    // External writes: the parent replaced the text (slash replacement,
    // draft restore, submit, ...) — rebuild the doc, keeping the caret at the
    // same projected offset. History starts over with the new state: mapping
    // the old undo stack across a full replacement would let Cmd+Z resurrect
    // already-sent text or apply another tab's steps to this draft.
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const last = lastProjectedRef.current
      if (value === last.text && mentionsEqual(mentions, last.mentions)) return

      const previousAnchor = pmPosToTextOffset(view.state.doc, view.state.selection.anchor)
      const doc = buildComposerDoc(value, mentions)
      const nextAnchor = textOffsetToPmPos(doc, Math.min(previousAnchor, projectedDocLength(doc)))
      lastProjectedRef.current = { text: value, mentions }
      view.updateState(EditorState.create({
        schema: composerSchema,
        doc,
        plugins: view.state.plugins,
        selection: TextSelection.near(doc.resolve(nextAnchor)),
      }))
      syncEmptyState(view, propsRef.current.placeholder)
    }, [value, mentions])

    // Dynamic editor chrome: classes and aria attributes are not part of the
    // document, so they are applied straight to the editable element.
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      view.dom.className = `composer-pm${editorClassName ? ` ${editorClassName}` : ''}`
    }, [editorClassName])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      syncEmptyState(view, placeholder)
    }, [placeholder])

    useEffect(() => {
      const view = viewRef.current
      if (!view || !aria) return
      for (const [name, attributeValue] of Object.entries(aria)) {
        if (attributeValue === undefined) view.dom.removeAttribute(name)
        else view.dom.setAttribute(name, attributeValue)
      }
    }, [aria])

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      getSelectionOffsets: () => {
        const view = viewRef.current
        if (!view) return { start: 0, end: 0 }
        const { from, to } = view.state.selection
        return {
          start: pmPosToTextOffset(view.state.doc, from),
          end: pmPosToTextOffset(view.state.doc, to),
        }
      },
      setSelectionOffsets: (start, end = start) => {
        const view = viewRef.current
        if (!view) return
        const docLength = projectedDocLength(view.state.doc)
        const from = textOffsetToPmPos(view.state.doc, Math.min(start, docLength))
        const to = textOffsetToPmPos(view.state.doc, Math.min(end, docLength))
        const selection = from === to
          ? TextSelection.near(view.state.doc.resolve(from))
          : TextSelection.create(view.state.doc, from, to)
        view.dispatch(view.state.tr.setSelection(selection))
      },
      getModelContent: () => {
        const view = viewRef.current
        return view ? serializeComposerDoc(view.state.doc) : ''
      },
    }), [])

    return (
      <div
        ref={(node) => {
          containerRef.current = node
          if (typeof rootRef === 'function') rootRef(node)
          else if (rootRef) (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        }}
        className={className}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />
    )
  },
)
