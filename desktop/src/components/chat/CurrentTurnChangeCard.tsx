import { useCallback, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react'
import type { SessionTurnCheckpoint } from '../../api/sessions'
import { useTranslation, type TranslationKey } from '../../i18n'
import { OpenWithMenu } from '../common/OpenWithMenu'
import { buildOpenWithItems, describeFileType, isPreviewableChangedFile, type OpenWithItem } from '../../lib/openWithItems'
import { openWithContextForWorkspaceFile } from '../../lib/openWithContextForHref'
import { isAbsoluteLocalPath, localFileUrl } from '../../lib/handlePreviewLink'
import { shouldOfferStaticHtmlPreview } from '../../lib/htmlPreviewPolicy'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { getDesktopHost } from '../../lib/desktopHost'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'

type CurrentTurnChangeCardProps = {
  sessionId: string
  checkpoint: SessionTurnCheckpoint
  workDir: string | null
  error: string | null
  isUndoing: boolean
  isLatest: boolean
  onUndo: () => void
}

type ChangedFileEntry = {
  apiPath: string
  displayPath: string
}

const COLLAPSED_COUNT = 5

export function CurrentTurnChangeCard({
  sessionId,
  checkpoint,
  workDir,
  error,
  isUndoing,
  isLatest,
  onUndo,
}: CurrentTurnChangeCardProps) {
  const t = useTranslation()
  const [openWith, setOpenWith] = useState<{ items: OpenWithItem[]; anchor: DOMRect; triggerEl: HTMLElement } | null>(null)
  const [showAllFiles, setShowAllFiles] = useState(false)

  const files = useMemo<ChangedFileEntry[]>(
    () => checkpoint.code.filesChanged
      .map((filePath) => ({
        apiPath: filePath,
        displayPath: relativizeWorkspacePath(filePath, workDir),
      }))
      .sort((a, b) => Number(isPreviewableChangedFile(b.displayPath)) - Number(isPreviewableChangedFile(a.displayPath))),
    [checkpoint.code.filesChanged, workDir],
  )

  const canCollapse = files.length > COLLAPSED_COUNT
  const visibleFiles = canCollapse && !showAllFiles
    ? files.slice(0, COLLAPSED_COUNT)
    : files

  const openChangedFile = useCallback((event: ReactMouseEvent<HTMLButtonElement>, fileEntry: ChangedFileEntry) => {
    const renderItem = event.currentTarget.closest<HTMLElement>('[data-chat-render-item-key]')
    const origin = {
      sourceTurnKey: renderItem?.dataset.chatRenderItemKey ?? checkpoint.target.targetUserMessageId,
      sourceElementId: event.currentTarget.id,
    }
    // A changed file outside the workdir (absolute displayPath — e.g. another
    // drive) has no checkpoint baseline, so a diff is meaningless. Render html in
    // the in-app browser and everything else as a file preview (served by its
    // absolute path). In-workdir files keep the diff view.
    if (isAbsoluteLocalPath(fileEntry.displayPath)) {
      if (shouldOfferStaticHtmlPreview(fileEntry.displayPath, { siblingFiles: files.map((entry) => entry.displayPath) })) {
        useBrowserPanelStore.getState().open(sessionId, localFileUrl(getServerBaseUrl(), fileEntry.apiPath))
        return
      }
      void useWorkspacePanelStore.getState().openPreview(sessionId, fileEntry.displayPath, 'file', origin)
      return
    }
    // Jump to the right-side workspace and open a diff tab. We pass the workDir-relative
    // path (same format the workspace file tree passes to openPreview), so the diff tab
    // is keyed/fetched identically to the tree-driven one.
    void useWorkspacePanelStore.getState().openPreview(sessionId, fileEntry.displayPath, 'diff', origin)
  }, [checkpoint.target.targetUserMessageId, sessionId, files])

  const handleOpenWith = useCallback((event: ReactMouseEvent<HTMLButtonElement>, fileEntry: ChangedFileEntry) => {
    event.stopPropagation()
    // Toggle: if the menu is already open, a second click on the trigger closes it
    // (the OpenWithMenu's outside-mousedown handler excludes the trigger, so its
    //  own click is the only thing that can close it on re-click).
    if (openWith) {
      setOpenWith(null)
      return
    }
    const triggerEl = event.currentTarget
    const rect = triggerEl.getBoundingClientRect()
    void (async () => {
      await useOpenTargetStore.getState().ensureTargets()
      const targets = useOpenTargetStore.getState().targets
      const ctx = openWithContextForWorkspaceFile(fileEntry.displayPath, fileEntry.apiPath, {
        sessionId,
        serverBaseUrl: getServerBaseUrl(),
        siblingFiles: files.map((entry) => entry.displayPath),
      })
      const items = buildOpenWithItems(ctx, targets, {
        openInAppBrowser: (url) => useBrowserPanelStore.getState().open(sessionId, url),
        openSystem: (p) => { void getDesktopHost().shell.openPath(p).catch(() => {}) },
        openWorkspacePreview: (rel) => { void useWorkspacePanelStore.getState().openPreview(sessionId, rel, 'file') },
        openTarget: (id, abs) => { void useOpenTargetStore.getState().openTarget(id, abs) },
        t: (k, v) => t(k as TranslationKey, v),
      })
      setOpenWith({ items, anchor: rect, triggerEl })
    })()
  }, [openWith, sessionId, t, files])

  const cardLabel = isLatest
    ? t('chat.turnChangesLatestCardLabel')
    : t('chat.turnChangesHistoricalCardLabel')
  const subtitle = isLatest
    ? t('chat.turnChangesLatestSubtitle')
    : t('chat.turnChangesCurrentWorkspaceDiff')
  const undoLabel = isLatest
    ? t('chat.turnChangesLatestUndo')
    : t('chat.turnChangesHistoricalUndo')
  const undoAria = isLatest
    ? t('chat.turnChangesLatestUndoAria')
    : t('chat.turnChangesHistoricalUndoAria')

  return (
    <section
      className="mx-auto mb-5 w-full max-w-[860px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm"
      aria-label={cardLabel}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">
              {t('chat.turnChangesTitle', { count: files.length })}
            </span>
            <span className="font-mono text-sm font-semibold text-[var(--color-success)]">
              +{checkpoint.code.insertions}
            </span>
            <span className="font-mono text-sm font-semibold text-[var(--color-error)]">
              -{checkpoint.code.deletions}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
            {subtitle}
          </div>
        </div>

        <button
          type="button"
          onClick={onUndo}
          disabled={isUndoing}
          aria-label={undoAria}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-brand)]/40 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[15px]">undo</span>
          {isUndoing ? t('chat.turnChangesUndoing') : undoLabel}
        </button>
      </div>

      <div className="divide-y divide-[var(--color-border)]">
        {visibleFiles.map((fileEntry) => {
          const fileName = fileEntry.displayPath.split('/').pop() || fileEntry.displayPath
          const typeInfo = describeFileType(fileEntry.displayPath)
          const previewable = isPreviewableChangedFile(fileEntry.displayPath)
          return (
            <div key={fileEntry.apiPath} className="flex items-center gap-2">
              <button
                type="button"
                id={`turn-change-opener-${checkpoint.target.targetUserMessageId}-${encodeURIComponent(fileEntry.apiPath)}`}
                data-source-turn-key={checkpoint.target.targetUserMessageId}
                onClick={(event) => openChangedFile(event, fileEntry)}
                aria-label={t('chat.turnChangesOpenInWorkspaceAria', { path: fileEntry.displayPath })}
                title={fileEntry.displayPath}
                className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-md)] px-4 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)]/35"
              >
                <span className="material-symbols-outlined shrink-0 text-[22px] text-[var(--color-text-tertiary)]">{typeInfo.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{fileName}</span>
                  <span className="block truncate text-xs text-[var(--color-text-tertiary)]">{`${t(typeInfo.categoryKey as Parameters<typeof t>[0])} · ${typeInfo.ext}`}</span>
                </span>
                <ChevronRight size={17} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
              </button>
              {previewable && (
                <button
                  type="button"
                  aria-label={t('openWith.title')}
                  onClick={(event) => handleOpenWith(event, fileEntry)}
                  className="mr-2 inline-flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35"
                >
                  {t('openWith.title')}
                  <ChevronDown size={14} strokeWidth={1.9} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {canCollapse && (
        <button
          type="button"
          onClick={() => setShowAllFiles((current) => !current)}
          className="flex w-full items-center justify-center gap-1 border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)]/35"
        >
          {showAllFiles ? (
            <>
              {t('chat.turnChangesShowLess')}
              <ChevronUp size={14} strokeWidth={1.9} />
            </>
          ) : (
            <>
              {t('chat.turnChangesShowMore', { count: String(files.length - COLLAPSED_COUNT) })}
              <ChevronDown size={14} strokeWidth={1.9} />
            </>
          )}
        </button>
      )}

      {error && (
        <div className="border-t border-[var(--color-error)]/20 bg-[var(--color-error-container)]/18 px-4 py-3 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}

      {openWith && <OpenWithMenu items={openWith.items} anchor={openWith.anchor} triggerEl={openWith.triggerEl} onClose={() => setOpenWith(null)} />}
    </section>
  )
}

export function relativizeWorkspacePath(filePath: string, workDir: string | null): string {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const isAbsolute = normalizedPath.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedPath)
  if (!workDir || !isAbsolute) return normalizedPath

  const normalizedWorkDir = workDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const comparablePath = normalizedPath.toLowerCase()
  const comparableWorkDir = normalizedWorkDir.toLowerCase()
  if (comparablePath === comparableWorkDir) return ''
  if (comparablePath.startsWith(`${comparableWorkDir}/`)) {
    return normalizedPath.slice(normalizedWorkDir.length + 1)
  }
  return normalizedPath
}
