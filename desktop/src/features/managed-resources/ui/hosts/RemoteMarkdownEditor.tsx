import { useEffect, useRef, useState } from 'react'
import { EditorState, type Command } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, selectAll, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { Bold, Italic, Code, Quote, List, Undo2, Redo2 } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { parseRemoteMarkdown, remoteMarkdownSchema as schema, type RemoteMarkdownDocument } from './remoteMarkdownModel'
import 'prosemirror-view/style/prosemirror.css'
import './remoteFileEditor.css'

type Props = { value: string; onChange: (value: string) => void; disabled?: boolean; label: string; describedBy?: string }
export function RemoteMarkdownEditor(props: Props) {
  const t = useTranslation()
  const mount = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const currentProps = useRef(props)
  currentProps.current = props
  const emitted = useRef(props.value)
  const model = useRef<RemoteMarkdownDocument | null>(null)
  const [hasSourceBlocks, setHasSourceBlocks] = useState(false)
  const createState = (value: string) => {
    const parsed = parseRemoteMarkdown(value)
    model.current = parsed
    setHasSourceBlocks(parsed.hasSourceBlocks)
    return EditorState.create({
      schema, doc: parsed.doc,
      plugins: [history(), keymap({
        'Mod-a': selectAll, 'Mod-b': toggleMark(schema.marks.strong!), 'Mod-i': toggleMark(schema.marks.em!),
        'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
        'Shift-Enter': (state, dispatch) => { dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break!.create()).scrollIntoView()); return true },
      }), keymap(baseKeymap)],
    })
  }
  useEffect(() => {
    if (!mount.current) return
    const editor = new EditorView(mount.current, {
      state: createState(currentProps.current.value),
      editable: () => !currentProps.current.disabled,
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': currentProps.current.label, spellcheck: 'false' },
      dispatchTransaction(transaction) {
        const next = editor.state.apply(transaction)
        editor.updateState(next)
        if (transaction.docChanged && !currentProps.current.disabled && model.current) {
          const markdown = model.current.serialize(next.doc)
          emitted.current = markdown
          currentProps.current.onChange(markdown)
        }
      },
      handlePaste(editorView, event) {
        if (currentProps.current.disabled) return true
        const value = event.clipboardData?.getData('text/plain')
        if (value !== undefined) {
          editorView.dispatch(editorView.state.tr.insertText(value).scrollIntoView())
          return true
        }
        return false
      },
      handleDOMEvents: {
        // No embedded HTML, file drops, navigation or image fetching from a remote document.
        drop(_editorView, event) { event.preventDefault(); return true },
      },
    })
    view.current = editor
    emitted.current = currentProps.current.value
    return () => { editor.destroy(); view.current = null; model.current = null }
  }, [])
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.setProps({
      editable: () => !props.disabled,
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': props.label, spellcheck: 'false', ...(props.describedBy ? { 'aria-describedby': props.describedBy } : {}) },
    })
    if (props.value !== emitted.current) {
      emitted.current = props.value
      editor.updateState(createState(props.value))
    }
  }, [props.value, props.disabled, props.label, props.describedBy])
  const execute = (command: Command) => {
    const editor = view.current
    if (!editor || currentProps.current.disabled) return
    command(editor.state, editor.dispatch, editor)
    editor.focus()
  }
  const actions = [
    { key: 'bold', icon: <Bold size={14} />, command: toggleMark(schema.marks.strong!) },
    { key: 'italic', icon: <Italic size={14} />, command: toggleMark(schema.marks.em!) },
    { key: 'inlineCode', icon: <Code size={14} />, command: toggleMark(schema.marks.code!) },
    { key: 'quote', icon: <Quote size={14} />, command: wrapIn(schema.nodes.blockquote!) },
    { key: 'list', icon: <List size={14} />, command: wrapIn(schema.nodes.bullet_list!) },
    { key: 'undo', icon: <Undo2 size={14} />, command: undo },
    { key: 'redo', icon: <Redo2 size={14} />, command: redo },
  ]
  return (
    <div className="remote-markdown-editor flex min-h-0 flex-1 flex-col" data-testid="remote-markdown-editor">
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1" role="toolbar" aria-label={t('managedResources.files.editor.formatToolbar' as never)} onMouseDown={event => event.preventDefault()}>
        <Button size="xs" variant="ghost" disabled={props.disabled} onClick={() => execute(setBlockType(schema.nodes.paragraph!))}>{t('managedResources.files.editor.paragraph' as never)}</Button>
        {[1, 2, 3].map(level => (
          <Button key={level} size="xs" variant="ghost" disabled={props.disabled} aria-label={t('managedResources.files.editor.heading' as never, { level })} onClick={() => execute(setBlockType(schema.nodes.heading!, { level }))}>H{level}</Button>
        ))}
        {actions.map(action => <IconButton key={action.key} size="xs" icon={action.icon} label={t(`managedResources.files.editor.${action.key}` as never)} disabled={props.disabled} onClick={() => execute(action.command)} />)}
      </div>
      {hasSourceBlocks && <p className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">{t('managedResources.files.editor.preservedSource' as never)}</p>}
      <div ref={mount} className="remote-markdown-mount min-h-0 flex-1 overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)]" />
    </div>
  )
}
