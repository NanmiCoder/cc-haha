import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'

import { sessionsApi, type SaveWorkspaceFileInput } from '../../api/sessions'
import {
  useWorkspacePanelStore,
  type WorkspaceBufferInit,
  type WorkspaceBufferState,
  type WorkspacePreviewTab,
} from '../../stores/workspacePanelStore'
import { detectEncoding, detectLineEnding } from './encodingDetect'
import { ConflictBanner } from './ConflictBanner'
import { UnsavedChangesModal } from './UnsavedChangesModal'

/**
 * In-app code editor for the workspace panel — Phase 2 of editor-lsp-foundation.
 *
 * Wraps a CodeMirror 6 EditorView, hands its dirty state through the
 * shared `useWorkspacePanelStore.bufferStateByTabId`, and saves through the
 * R2 atomic-write endpoint via `sessionsApi.saveWorkspaceFile`.
 *
 * Encoding detection runs on the loaded buffer; an `'unsupported'` result
 * blocks editor mounting and falls back to the existing read-only preview
 * surface (the parent panel decides what to render once `unsupportedEncoding`
 * fires through `onUnsupportedEncoding`).
 *
 * Conflict-banner and unsaved-changes-modal handling live here too — agent
 * source events stay dormant until PR-4 wires them through the store.
 *
 * _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8 (Phase 2 task 8)_
 */

const SAVE_TIMEOUT_MS = 30_000

const LANGUAGE_BY_EXTENSION: Record<string, () => unknown> = {
  ts: javascript,
  tsx: () => javascript({ jsx: true, typescript: true }),
  js: javascript,
  jsx: () => javascript({ jsx: true }),
  mjs: javascript,
  cjs: javascript,
  json: json,
  jsonc: json,
  md: markdown,
  markdown: markdown,
}

function pickLanguage(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const factory = LANGUAGE_BY_EXTENSION[ext]
  if (!factory) return null
  return factory() as ReturnType<typeof javascript>
}

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export type SaveWorkspaceBufferResult =
  | { ok: true }
  | { ok: false; message: string }

export async function saveWorkspaceBuffer(
  sessionId: string,
  buffer: WorkspaceBufferState,
  initBuffer: (init: WorkspaceBufferInit) => void,
): Promise<SaveWorkspaceBufferResult> {
  const payload: SaveWorkspaceFileInput = {
    path: buffer.path,
    content: buffer.currentContent,
    expectedBaseHash: buffer.baseHash,
    bom: buffer.encoding === 'utf-8-bom' ? 'utf-8' : 'none',
    lineEnding: buffer.lineEnding,
  }

  try {
    const result = await sessionsApi.saveWorkspaceFile(sessionId, payload)
    if (!result.ok) {
      return { ok: false, message: result.message }
    }

    initBuffer({
      tabId: buffer.tabId,
      path: buffer.path,
      baseHash: result.hash,
      baseContent: buffer.currentContent,
      encoding: buffer.encoding,
      lineEnding: buffer.lineEnding,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to save' }
  }
}

export type WorkspaceEditorProps = {
  sessionId: string
  tab: WorkspacePreviewTab
  /** Called when the file's encoding is unsupported so the parent can fall
   *  back to the read-only preview surface. */
  onUnsupportedEncoding?: (path: string) => void
  onSaved?: (path: string) => void
  /** Called when the user explicitly closes the tab (caller manages tab
   *  lifecycle through the store). */
  onClose?: () => void
}

export function WorkspaceEditor(props: WorkspaceEditorProps) {
  const { sessionId, tab, onUnsupportedEncoding, onSaved, onClose } = props

  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lspDebounceRef = useRef<number | undefined>(undefined)

  const buffer = useWorkspacePanelStore((s) => s.bufferStateByTabId[tab.id])
  const initBuffer = useWorkspacePanelStore((s) => s.initBuffer)
  const setBufferState = useWorkspacePanelStore((s) => s.setBufferState)
  const acknowledgeConflict = useWorkspacePanelStore((s) => s.acknowledgeConflict)
  const syncLsp = useWorkspacePanelStore((s) => s.syncLsp)

  const [unsupported, setUnsupported] = useState(false)
  const [saving, setSaving] = useState(false)
  const [closeRequested, setCloseRequested] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // -- Initialize the buffer state from the loaded preview tab content. ----
  useEffect(() => {
    if (buffer) return // already initialized
    if (typeof tab.content !== 'string') return
    let cancelled = false
    ;(async () => {
      const bytes = new TextEncoder().encode(tab.content!)
      const encoding = detectEncoding(bytes)
      if (encoding === 'unsupported') {
        if (cancelled) return
        setUnsupported(true)
        onUnsupportedEncoding?.(tab.path)
        return
      }
      const lineEnding = detectLineEnding(tab.content!)
      const baseHash = await sha256Hex(tab.content!)
      if (cancelled) return
      initBuffer({
        tabId: tab.id,
        path: tab.path,
        baseHash,
        baseContent: tab.content!,
        encoding,
        lineEnding,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [buffer, tab.id, tab.path, tab.content, initBuffer, onUnsupportedEncoding])

  useEffect(() => {
    if (!buffer || unsupported) return
    void syncLsp(sessionId, { path: buffer.path, content: buffer.currentContent, event: 'open' })
  }, [buffer?.tabId, sessionId, syncLsp, unsupported])

  // -- Mount the CodeMirror view once we have an initialized buffer. -------
  useEffect(() => {
    if (!buffer || unsupported) return
    if (!containerRef.current) return
    if (viewRef.current) return

    const language = pickLanguage(buffer.path)
    const extensions = [
      lineNumbers(),
      history(),
      bracketMatching(),
      indentOnInput(),
      search(),
      autocompletion(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap]),
      EditorState.tabSize.of(2),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const content = update.state.doc.toString()
        setBufferState(buffer.tabId, content)
        window.clearTimeout(lspDebounceRef.current)
        lspDebounceRef.current = window.setTimeout(() => {
          void syncLsp(sessionId, { path: buffer.path, content, event: 'change' })
        }, 350)
      }),
    ]
    if (language) extensions.push(language)

    const view = new EditorView({
      state: EditorState.create({
        doc: buffer.currentContent,
        extensions,
      }),
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      window.clearTimeout(lspDebounceRef.current)
      view.destroy()
      viewRef.current = null
    }
    // We deliberately depend on tab.id (stable per tab) rather than `buffer`
    // to avoid re-mounting on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer?.tabId, unsupported])

  // -- External rebase: when the buffer's currentContent changes from
  // outside the editor (e.g. applyExternalSave on a clean buffer), push it
  // back into the EditorView. We compare against the view's current doc to
  // avoid feedback loops with the updateListener.
  useEffect(() => {
    if (!buffer || !viewRef.current) return
    const current = viewRef.current.state.doc.toString()
    if (current === buffer.currentContent) return
    viewRef.current.dispatch({
      changes: { from: 0, to: current.length, insert: buffer.currentContent },
    })
  }, [buffer?.currentContent])

  // -- Save: POST to the workspace file endpoint, then re-init the buffer. -
  const performSave = useCallback(async (): Promise<boolean> => {
    if (!buffer) return false
    setSaving(true)
    setSaveError(null)
    const timeoutHandle = setTimeout(() => {
      setSaveError('Save timed out')
      setSaving(false)
    }, SAVE_TIMEOUT_MS)

    const result = await saveWorkspaceBuffer(sessionId, buffer, initBuffer)
    clearTimeout(timeoutHandle)
    setSaving(false)

    if (!result.ok) {
      setSaveError(result.message)
      return false
    }

    onSaved?.(buffer.path)
    void syncLsp(sessionId, { path: buffer.path, content: buffer.currentContent, event: 'save' })
    return true
  }, [buffer, sessionId, initBuffer, onSaved, syncLsp])

  // -- Close: dirty buffer triggers the unsaved-changes modal. -------------
  const handleClose = useCallback(() => {
    if (buffer?.isDirty) {
      setCloseRequested(true)
      return
    }
    onClose?.()
  }, [buffer?.isDirty, onClose])

  const handleModalDiscard = useCallback(() => {
    setCloseRequested(false)
    onClose?.()
  }, [onClose])

  const handleModalSave = useCallback(async () => {
    const success = await performSave()
    if (success) {
      setCloseRequested(false)
      onClose?.()
    }
  }, [performSave, onClose])

  const handleModalCancel = useCallback(() => {
    setCloseRequested(false)
  }, [])

  const handleModalTimeout = useCallback(() => {
    setCloseRequested(false)
    setSaveError('Close prompt timed out — buffer kept dirty')
  }, [])

  // -- Conflict banner actions. --------------------------------------------
  const handleConflictReload = useCallback(() => {
    if (!buffer) return
    acknowledgeConflict(buffer.tabId, 'reload')
  }, [buffer, acknowledgeConflict])

  const handleConflictKeepMine = useCallback(() => {
    if (!buffer) return
    acknowledgeConflict(buffer.tabId, 'keepMine')
  }, [buffer, acknowledgeConflict])

  const handleConflictOpenView = useCallback(() => {
    if (!buffer) return
    acknowledgeConflict(buffer.tabId, 'openConflict')
  }, [buffer, acknowledgeConflict])

  // -- Render. -------------------------------------------------------------
  const dirtyMarker = useMemo(() => (buffer?.isDirty ? '●' : ''), [buffer?.isDirty])

  if (unsupported) {
    return (
      <div
        data-testid="workspace-editor-unsupported"
        className="flex h-full items-center justify-center text-[12px] text-[var(--color-text-muted)]"
      >
        unsupported-encoding · this file uses an encoding the editor cannot open. Read-only preview
        is available below.
      </div>
    )
  }

  if (!buffer) {
    return (
      <div
        data-testid="workspace-editor-loading"
        className="flex h-full items-center justify-center text-[12px] text-[var(--color-text-muted)]"
      >
        Loading editor…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 text-[12px]">
        <span data-testid="workspace-editor-path" className="font-medium text-[var(--color-text)]">
          {dirtyMarker} {buffer.path}
        </span>
        <span className="text-[var(--color-text-muted)]">
          {buffer.encoding} · {buffer.lineEnding}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="workspace-editor-save"
            disabled={saving || !buffer.isDirty}
            onClick={() => void performSave()}
            className="rounded-[6px] border border-[var(--color-border)] px-2.5 py-1 text-[12px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            data-testid="workspace-editor-close"
            onClick={handleClose}
            className="rounded-[6px] border border-[var(--color-border)] px-2.5 py-1 text-[12px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
          >
            Close
          </button>
        </div>
      </div>

      {buffer.conflict && (
        <ConflictBanner
          filePath={buffer.path}
          isDirty={buffer.isDirty}
          conflict={buffer.conflict}
          onReload={handleConflictReload}
          onKeepMine={handleConflictKeepMine}
          onOpenConflictView={handleConflictOpenView}
        />
      )}

      {saveError && (
        <div
          role="alert"
          data-testid="workspace-editor-save-error"
          className="border-b border-[var(--color-error-border)] bg-[var(--color-error-surface)] px-3 py-1.5 text-[12px] text-[var(--color-error-text)]"
        >
          {saveError}
        </div>
      )}

      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto" />

      <UnsavedChangesModal
        open={closeRequested}
        filePath={buffer.path}
        isSaving={saving}
        onDiscard={handleModalDiscard}
        onSave={handleModalSave}
        onCancel={handleModalCancel}
        onTimeout={handleModalTimeout}
      />
    </div>
  )
}
