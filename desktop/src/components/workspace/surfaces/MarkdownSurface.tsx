import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { clearWindowSelection, useSelectionPopoverDismiss } from '@/hooks/useSelectionPopoverDismiss'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { createWorkspaceMarkdownImageResolver } from '@/lib/markdownImages'
import { getServerBaseUrl } from '@/lib/desktopRuntime'
import { FloatingSelectionMenu } from './FloatingSelectionMenu'
import {
  getLineRangeForText,
  getTextSelectionFromContainer,
  type FloatingSelectionMenuState,
  type WorkspaceTextSelection,
} from './textSelection'

export function MarkdownSurface({
  value,
  path,
  sessionId,
  workDir,
  onAddSelection,
}: {
  value: string
  path: string
  sessionId: string
  workDir?: string | null
  onAddSelection: (selection: WorkspaceTextSelection) => void
}) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const selectionMenuRef = useRef<HTMLButtonElement>(null)
  const [selectionMenu, setSelectionMenu] = useState<FloatingSelectionMenuState | null>(null)

  // The document is user-owned local content, so its images are trusted:
  // relative paths resolve against the file's directory (served sandboxed via
  // /preview-fs or /local-file) and remote URLs are left to CSP. Untrusted
  // assistant Markdown gets no resolver and keeps the blob:/data:-only policy.
  const resolveImageSrc = useMemo(
    () => createWorkspaceMarkdownImageResolver({
      baseUrl: getServerBaseUrl(),
      sessionId,
      filePath: path,
      workDir,
    }),
    [path, sessionId, workDir],
  )

  useEffect(() => {
    setSelectionMenu(null)
  }, [value])

  const dismissSelectionMenu = useCallback(() => {
    setSelectionMenu(null)
  }, [])

  useSelectionPopoverDismiss({
    active: Boolean(selectionMenu),
    popoverRef: selectionMenuRef,
    onDismiss: dismissSelectionMenu,
  })

  const handleSelectionMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.ctrlKey) {
      setSelectionMenu(null)
      return
    }
    setSelectionMenu(getTextSelectionFromContainer(
      surfaceRef.current,
      (text) => getLineRangeForText(value, text),
      event,
    ))
  }

  const addCurrentSelectionToChat = () => {
    if (!selectionMenu) return
    onAddSelection({
      text: selectionMenu.text,
      startLine: selectionMenu.startLine,
      endLine: selectionMenu.endLine,
    })
    setSelectionMenu(null)
    clearWindowSelection()
  }

  return (
    <div
      ref={surfaceRef}
      data-workspace-scroll-surface=""
      className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface)]"
      onMouseUp={handleSelectionMouseUp}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelectionMenu(null)
      }}
    >
      <div className="mx-auto w-full max-w-[860px] px-6 py-5">
        <MarkdownRenderer
          content={value}
          variant="document"
          resolveImageSrc={resolveImageSrc}
          className="workspace-markdown-preview prose-p:text-[14px] prose-p:leading-7 prose-h1:text-[24px] prose-h2:text-[18px] prose-h3:text-[15px] prose-code:text-[12px] prose-pre:my-4"
        />
      </div>
      <FloatingSelectionMenu selection={selectionMenu} onAdd={addCurrentSelectionToChat} popoverRef={selectionMenuRef} />
    </div>
  )
}
