import { useCallback, useId, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Ellipsis, FileDiff, TriangleAlert, Undo2 } from 'lucide-react'
import type { SessionTurnCheckpoint } from '../../api/sessions'
import { useTranslation, type TranslationKey } from '../../i18n'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { OpenWithMenu } from '@/components/composite/OpenWithMenu'
import { FileTypeIcon } from '@/components/ui/FileTypeIcon'
import { describeFileType, isPreviewableChangedFile, type OpenWithItem } from '../../lib/openWithItems'
import { buildOpenWithMenuItems } from '../../lib/openWithMenuItems'
import { openWithContextForWorkspaceFile } from '../../lib/openWithContextForHref'
import { isAbsoluteLocalPath, localFileUrl } from '../../lib/handlePreviewLink'
import { shouldOfferStaticHtmlPreview } from '../../lib/htmlPreviewPolicy'
import { getServerBaseUrl } from '../../lib/desktopRuntime'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { workspaceOpen } from '../../lib/workspace/openTarget'
import { isWorkspaceDocumentFile, isWorkspacePreviewableFile } from '../../lib/fileCapabilities'
import { openLocalFileWithSystem, reportOpenFailure } from '../../lib/systemFileOpen'

type CurrentTurnChangeCardProps = {
  sessionId: string
  checkpoint: SessionTurnCheckpoint
  workDir: string | null
  error: string | null
  isUndoing: boolean
  isLatest: boolean
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
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
  expanded,
  onExpandedChange,
}: CurrentTurnChangeCardProps) {
  const t = useTranslation()
  const filesId = useId()
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
  const restoreAvailable = checkpoint.restoreAvailable !== false
  // Undo restores every file listed above, but a turn that also ran a writing
  // shell command may have touched files no checkpoint captured. Say so instead
  // of withholding the undo — the listed files are still exactly reversible.
  const unverifiedChangeSources = checkpoint.unverifiedChangeSources ?? []
  const hasUnverifiedChanges = restoreAvailable && unverifiedChangeSources.length > 0

  const openChangedFile = useCallback((event: ReactMouseEvent<HTMLButtonElement>, fileEntry: ChangedFileEntry) => {
    const renderItem = event.currentTarget.closest<HTMLElement>('[data-chat-render-item-key]')
    const origin = {
      sourceTurnKey: renderItem?.dataset.chatRenderItemKey ?? checkpoint.target.targetUserMessageId,
      sourceElementId: event.currentTarget.id,
    }
    if (!isWorkspacePreviewableFile(fileEntry.displayPath)) {
      void openLocalFileWithSystem(fileEntry.apiPath).catch(() => reportOpenFailure(fileEntry.apiPath))
      return
    }
    // A changed file outside the workdir (absolute displayPath — e.g. another
    // drive) has no checkpoint baseline, so a diff is meaningless. Render html in
    // the in-app browser and everything else as a file preview (served by its
    // absolute path). In-workdir files keep the diff view.
    if (isAbsoluteLocalPath(fileEntry.displayPath)) {
      if (shouldOfferStaticHtmlPreview(fileEntry.displayPath, { siblingFiles: files.map((entry) => entry.displayPath) })) {
        workspaceOpen.browser(sessionId, localFileUrl(getServerBaseUrl(), fileEntry.apiPath), { origin })
        return
      }
      workspaceOpen.file(sessionId, fileEntry.displayPath, { origin })
      return
    }
    // A document has no line diff: the turn's recorded change for it is empty, so
    // the review view would open onto nothing. What was asked for is the document.
    if (isWorkspaceDocumentFile(fileEntry.displayPath)) {
      workspaceOpen.file(sessionId, fileEntry.displayPath, { origin })
      return
    }
    // Jump to the right-side workspace and show this turn's own recorded change
    // for that file. The `turn` source deliberately does not become a current-Git
    // comparison: the card is about what this turn did, not about what the
    // working tree happens to hold now.
    workspaceOpen.review(sessionId, {
      source: { kind: 'turn', turnKey: checkpoint.target.targetUserMessageId ?? '', userMessageIndex: checkpoint.target.userMessageIndex },
      path: fileEntry.displayPath,
      origin,
    })
  }, [checkpoint.target.targetUserMessageId, checkpoint.target.userMessageIndex, sessionId, files])

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
      const targets = await useOpenTargetStore.getState().getTargetsForPath(fileEntry.apiPath)
      const ctx = openWithContextForWorkspaceFile(fileEntry.displayPath, fileEntry.apiPath, {
        sessionId,
        serverBaseUrl: getServerBaseUrl(),
        siblingFiles: files.map((entry) => entry.displayPath),
      })
      // The shared dependency factory, not a fourth hand-copied set: this call
      // site was the one that never adopted it, which is why the changed-file
      // menu was missing the copy entries every other surface has.
      const items = buildOpenWithMenuItems(ctx, targets, {
        sessionId,
        t: (k, v) => t(k as TranslationKey, v),
      })
      setOpenWith({ items, anchor: rect, triggerEl })
    })()
  }, [openWith, sessionId, t, files])

  if (files.length === 0) return null

  const cardLabel = isLatest
    ? t('chat.turnChangesLatestCardLabel')
    : t('chat.turnChangesHistoricalCardLabel')
  const subtitle = !restoreAvailable
    ? t('chat.turnChangesConversationOnlySubtitle')
    : hasUnverifiedChanges
      ? t('chat.turnChangesPartialCoverageSubtitle', {
          sources: unverifiedChangeSources.join(', '),
        })
      : isLatest
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
      // Follows the message it belongs to inside the same rail box, so it takes a
      // top margin and no width of its own — `max-w-[900px]` here would have
      // overflowed the column once the rail indented it.
      className="mt-2.5 w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]"
      aria-label={cardLabel}
    >
      {/* One 40px line. The disclosure's hit area is stretched over the whole
          row (its ::after), so the trailing chevron toggles too; the undo
          button is lifted above that layer to keep its own click. */}
      <div className="relative flex h-10 items-center gap-2 pl-3 pr-2">
        <button
          type="button"
          data-chat-disclosure="true"
          data-turn-change-disclosure="true"
          aria-expanded={expanded}
          aria-controls={filesId}
          aria-label={t(expanded ? 'chat.turnChangesCollapse' : 'chat.turnChangesExpand', { count: files.length })}
          onClick={() => {
            setOpenWith(null)
            onExpandedChange(!expanded)
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] focus-visible:outline-none after:absolute after:inset-0 after:rounded-[var(--radius-lg)] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-[var(--color-border-focus)]"
        >
          <FileDiff size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="truncate font-medium text-[var(--color-text-primary)]">
            {t('chat.turnChangesTitle', { count: files.length })}
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--color-diff-added-text)]">+{checkpoint.code.insertions}</span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--color-diff-removed-text)]">-{checkpoint.code.deletions}</span>
        </button>

        {/* Never disabled: rolling the conversation back is always possible, even
            when the files are not restorable. The dialog picks what to touch.
            What the checkpoint covers is the button's hint rather than a line
            of grey text under every card; the confirm dialog repeats it. */}
        <Button
          variant="ghost"
          size="sm"
          loading={isUndoing}
          onClick={onUndo}
          aria-label={undoAria}
          title={subtitle}
          className="relative shrink-0"
          icon={<Undo2 size={13} strokeWidth={1.75} aria-hidden="true" />}
        >
          {isUndoing ? t('chat.turnChangesUndoing') : undoLabel}
        </Button>
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className={`pointer-events-none shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
        />
      </div>

      {/* A partial checkpoint changes what undo will do, so that one stays in
          view; the routine "what this card compares" notes live in the hint. */}
      {hasUnverifiedChanges && (
        <div className="flex items-start gap-2 border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
          <TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
          <span className="min-w-0">{subtitle}</span>
        </div>
      )}

      <div id={filesId} hidden={!expanded}>
        {expanded && <div className="border-t border-[var(--color-border)] py-1">
          {visibleFiles.map((fileEntry) => {
            const fileName = fileEntry.displayPath.split('/').pop() || fileEntry.displayPath
            const directory = fileEntry.displayPath.slice(0, fileEntry.displayPath.length - fileName.length)
            const typeInfo = describeFileType(fileEntry.displayPath)
            const workspacePreviewable = isWorkspacePreviewableFile(fileEntry.displayPath)
            return (
              <div key={fileEntry.apiPath} className="flex h-8 items-center gap-0.5 px-1.5">
                <button
                  type="button"
                  id={`turn-change-opener-${checkpoint.target.targetUserMessageId}-${encodeURIComponent(fileEntry.apiPath)}`}
                  data-source-turn-key={checkpoint.target.targetUserMessageId}
                  onClick={(event) => openChangedFile(event, fileEntry)}
                  aria-label={t(
                    workspacePreviewable
                      ? 'chat.turnChangesOpenInWorkspaceAria'
                      : 'chat.turnChangesOpenFileAria',
                    { path: fileEntry.displayPath },
                  )}
                  title={fileEntry.displayPath}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
                >
                  <FileTypeIcon path={fileEntry.displayPath} size={14} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-text-tertiary)]">
                    {directory}
                    <span className="font-medium text-[var(--color-text-primary)]">{fileName}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
                    {typeInfo.ext || t(typeInfo.categoryKey as Parameters<typeof t>[0])}
                  </span>
                  <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                </button>
                <IconButton
                  icon={<Ellipsis size={14} strokeWidth={1.75} aria-hidden="true" />}
                  label={t('openWith.title')}
                  size="xs"
                  tone="muted"
                  onClick={(event) => handleOpenWith(event, fileEntry)}
                />
              </div>
            )
          })}
        </div>}

        {expanded && canCollapse && (
          <button
            type="button"
            data-chat-disclosure="true"
            aria-expanded={showAllFiles}
            onClick={() => setShowAllFiles((current) => !current)}
            className="flex h-8 w-full items-center justify-center gap-1 border-t border-[var(--color-border)] px-4 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
          >
            {showAllFiles ? (
              <>
                {t('chat.turnChangesShowLess')}
                <ChevronUp size={14} strokeWidth={1.75} />
              </>
            ) : (
              <>
                {t('chat.turnChangesShowMore', { count: String(files.length - COLLAPSED_COUNT) })}
                <ChevronDown size={14} strokeWidth={1.75} />
              </>
            )}
          </button>
        )}

      </div>

      {error && (
        <div role="alert" className="border-t border-[var(--color-border)] bg-[var(--color-error-container)] px-3 py-2 text-xs text-[var(--color-on-error-container)]">
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
