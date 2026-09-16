import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, FolderClosed, FolderOpen } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { TargetIcon } from '@/components/composite/TargetIcon'
import { useWorkspaceFileOpenTargets } from '@/components/workspace/workspaceFileOpenTargets'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../i18n'
import { CodeSurface } from '../workspace/surfaces/CodeSurface'
import { ImagePreview } from '../workspace/surfaces/ImagePreview'
import { MarkdownSurface } from '../workspace/surfaces/MarkdownSurface'
import { PanelMessage } from '../workspace/surfaces/PanelMessage'
import type { WorkspaceTextSelection } from '../workspace/surfaces/textSelection'
import { WorkspaceFileOpenWith } from '../workspace/WorkspaceFileOpenWith'
import { WorkspaceTreeSidebar } from '@/components/workbench/WorkspaceTreeSidebar'
import { WorkspaceFileTreePane } from './WorkspaceFileTreePane'
import { useMenuKeyboard } from './menuKeyboard'
import { useWorkspaceContentStore, type WorkspaceFileView } from '../../stores/workspaceContentStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { workspaceOpen } from '../../lib/workspace/openTarget'
import { resolveAbsoluteOpenPath } from '../../lib/systemFileOpen'
import { basenameOf, type WorkspaceFileTab as WorkspaceFileTabModel } from '../../lib/workspace/types'

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx']

export type WorkspaceFileTabProps = {
  sessionId: string
  tab: WorkspaceFileTabModel
}

function isMarkdown(path: string) {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * File content with its tree alongside it.
 *
 * The tree is a sibling of the content, not a mode the content replaces, so
 * opening a file never changes the shape of the panel — it changes what the
 * selected row points at. Narrow widths collapse the tree rather than dropping
 * the content, because the content is what was asked for.
 */
export function WorkspaceFileTab({ sessionId, tab }: WorkspaceFileTabProps) {
  const t = useTranslation()
  const treeToggleRef = useRef<HTMLButtonElement>(null)
  const treeOpen = useWorkspaceContentStore((state) => state.treeViewBySession[sessionId]?.open ?? true)
  const setTreeOpen = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    const state = useWorkspaceContentStore.getState()
    const open = state.treeViewBySession[sessionId]?.open ?? true
    const nextOpen = typeof next === 'function' ? next(open) : next
    if (!nextOpen && document.activeElement?.closest('[data-testid="workspace-tree-sidebar"]')) {
      treeToggleRef.current?.focus({ preventScroll: true })
    }
    state.setTreeView(sessionId, { open: nextOpen })
  }, [sessionId])
  const [openWithOpen, setOpenWithOpen] = useState(false)
  const openWithRef = useRef<HTMLDivElement>(null)
  const openWithTriggerRef = useRef<HTMLButtonElement>(null)
  const openWithMenuId = useId()
  const loadFile = useWorkspaceContentStore((state) => state.loadFile)
  const loadStatus = useWorkspaceContentStore((state) => state.loadStatus)
  const entry = useWorkspaceContentStore((state) => state.filesByKey[`${sessionId}::${tab.path}`])
  /**
   * The working directory is read here rather than taken as a prop: it used to
   * be an optional prop that the only render site never passed, so every
   * "open with" and every Markdown asset resolved against a workspace-relative
   * path and opened the wrong target (or nothing at all).
   */
  const workDir = useWorkspaceContentStore((state) => state.statusBySession[sessionId]?.workDir) ?? null
  const repoName = useWorkspaceContentStore((state) => state.statusBySession[sessionId]?.repoName) ?? null
  const path = tab.path
  const fileContentRef = useRef<HTMLDivElement>(null)
  const restoredSurface = useRef<{ node: HTMLElement; revealNonce: number | undefined }>()
  const [consumedReveal, setConsumedReveal] = useState<string | null>(null)
  const viewKey = `${sessionId}::${path}`
  const revealKey = `${viewKey}::${tab.reveal?.nonce}`
  const restoredView = useRef<{ key: string; view: WorkspaceFileView | undefined }>()
  if (restoredView.current?.key !== viewKey) {
    restoredView.current = { key: viewKey, view: useWorkspaceContentStore.getState().fileViewByKey[viewKey] }
  }
  const savedView = restoredView.current.view
  const revealScroll = tab.reveal?.nonce !== savedView?.revealNonce && consumedReveal !== revealKey

  useLayoutEffect(() => {
    const surface = fileContentRef.current?.querySelector<HTMLElement>('[data-workspace-scroll-surface]')
    if (!surface) return
    if (restoredSurface.current?.node === surface && restoredSurface.current.revealNonce === tab.reveal?.nonce) return
    restoredSurface.current = { node: surface, revealNonce: tab.reveal?.nonce }
    surface.scrollTop = revealScroll ? 0 : savedView?.scrollTop ?? 0
    surface.scrollLeft = savedView?.scrollLeft ?? 0
    useWorkspaceContentStore.getState().setFileView(sessionId, path, {
      scrollTop: surface.scrollTop,
      scrollLeft: surface.scrollLeft,
      revealNonce: tab.reveal?.nonce,
    })
  }, [entry?.state, entry?.previewType, path, revealScroll, savedView, sessionId, tab.reveal?.nonce])

  useEffect(() => {
    const openSearch = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail.sessionId === sessionId) setTreeOpen(true)
    }
    window.addEventListener('workspace-quick-open', openSearch)
    return () => window.removeEventListener('workspace-quick-open', openSearch)
  }, [sessionId, setTreeOpen])

  useEffect(() => {
    if (!path) setTreeOpen(true)
  }, [path, setTreeOpen])

  useEffect(() => {
    void loadStatus(sessionId)
  }, [loadStatus, sessionId])

  useEffect(() => {
    if (!path) return
    void loadFile(sessionId, path)
  }, [loadFile, path, sessionId])

  const addSelectionToChat = useCallback((selection: WorkspaceTextSelection) => {
    useWorkspaceChatContextStore.getState().addReference(sessionId, {
      kind: 'code-selection',
      path,
      name: basenameOf(path),
      lineStart: selection.startLine,
      lineEnd: selection.endLine,
      quote: selection.text,
    })
  }, [path, sessionId])

  const addLineComment = useCallback((
    lineStart: number,
    lineEnd: number,
    note: string,
    quote: string,
  ) => {
    useWorkspaceChatContextStore.getState().addReference(sessionId, {
      kind: 'code-comment',
      path,
      name: basenameOf(path),
      lineStart,
      lineEnd,
      quote,
      note,
    })
  }, [path, sessionId])

  const closeOpenWith = useCallback(() => setOpenWithOpen(false), [])

  useDismissable({
    open: openWithOpen,
    refs: [openWithRef, openWithTriggerRef],
    onDismiss: closeOpenWith,
  })

  const handleOpenWithKeyDown = useMenuKeyboard({
    open: openWithOpen,
    menuRef: openWithRef,
    triggerRef: openWithTriggerRef,
    onClose: closeOpenWith,
  })

  const normalizedPath = path.replaceAll('\\', '/')
  const rootPrefix = workDir ? `${workDir.replaceAll('\\', '/').replace(/\/+$/, '')}/` : null
  const windowsRoot = rootPrefix && /^(?:[A-Za-z]:|\/\/)/.test(rootPrefix)
  const insideRoot = rootPrefix && (windowsRoot
    ? normalizedPath.toLowerCase().startsWith(rootPrefix.toLowerCase())
    : normalizedPath.startsWith(rootPrefix))
  // The server's canonical identity also resolves aliases and external chat
  // paths. Until it arrives, normalize separators without labelling a path
  // outside the project as project-relative.
  const relativePath = (entry?.watchPath ?? (insideRoot ? normalizedPath.slice(rootPrefix.length) : normalizedPath)).replaceAll('\\', '/')
  const segments = relativePath ? relativePath.split('/').filter(Boolean) : []
  const projectSegment = repoName && relativePath && !relativePath.startsWith('/') && !/^[A-Za-z]:/.test(relativePath) ? repoName : null
  const breadcrumbSegments = projectSegment ? [projectSegment, ...segments] : segments
  const absolutePath = resolveAbsoluteOpenPath(path, workDir ?? undefined)
  const fileOpen = useWorkspaceFileOpenTargets(path ? absolutePath : null)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-testid="workspace-file-header"
        className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3"
      >
        <nav
          aria-label={t('workspace.files.breadcrumb')}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[14px] text-[var(--color-text-tertiary)]"
        >
          {breadcrumbSegments.length === 0 ? (
            <span className="truncate">/</span>
          ) : (
            breadcrumbSegments.map((segment, index) => (
              <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-0.5">
                {index > 0 ? (
                  <ChevronRight size={13} aria-hidden="true" className="shrink-0 opacity-60" />
                ) : null}
                <span
                  className={`truncate ${index === breadcrumbSegments.length - 1 ? 'text-[var(--color-text-primary)]' : ''}`}
                >
                  {segment}
                </span>
              </span>
            ))
          )}
        </nav>
        <IconButton
          ref={treeToggleRef}
          icon={treeOpen
            ? <FolderOpen size={18} strokeWidth={1.8} />
            : <FolderClosed size={18} strokeWidth={1.8} />}
          label={t('workspace.files.toggleTree')}
          size="sm"
          tone="muted"
          pressed={treeOpen}
          data-testid="workspace-file-tree-toggle"
          onClick={() => setTreeOpen((open) => !open)}
        />
        {path ? (
          <>
            <span className="relative flex h-8 shrink-0 items-stretch rounded-[var(--radius-md)] border border-[var(--color-border)]">
              <button
                type="button"
                data-testid="workspace-file-open-primary"
                disabled={!fileOpen.primaryTarget}
                aria-label={fileOpen.primaryTarget ? t('openWith.openInTarget', { target: fileOpen.primaryTarget.label }) : t('workspace.files.openWith')}
                onClick={() => { if (fileOpen.primaryTarget) fileOpen.openTarget(fileOpen.primaryTarget) }}
                className="flex min-w-0 items-center gap-2 rounded-l-[var(--radius-md)] px-2 text-[14px] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:opacity-50"
              >
                <span aria-hidden="true">{fileOpen.primaryTarget ? <TargetIcon target={fileOpen.primaryTarget} size={16} /> : <ExternalLink size={16} />}</span>
                {t('workspace.files.openWith')}
              </button>
              <button
                ref={openWithTriggerRef}
                type="button"
                data-testid="workspace-file-open-with"
                aria-haspopup="menu"
                aria-expanded={openWithOpen}
                aria-controls={openWithOpen ? openWithMenuId : undefined}
                onClick={() => setOpenWithOpen((open) => !open)}
                aria-label={t('workspace.files.openWith')}
                className="flex w-7 items-center justify-center rounded-r-[var(--radius-md)] border-l border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {openWithOpen ? (
                <div
                  ref={openWithRef}
                  id={openWithMenuId}
                  role="menu"
                  aria-label={t('workspace.files.openWith')}
                  onKeyDown={handleOpenWithKeyDown}
                  className="absolute right-0 top-[34px] z-[var(--z-dropdown)] max-h-[65vh] w-[204px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1.5 shadow-[var(--shadow-dropdown)]"
                >
                  <WorkspaceFileOpenWith
                    absolutePath={absolutePath}
                    sessionId={sessionId}
                    workspacePath={path}
                    targets={fileOpen.targets}
                    loading={fileOpen.loading}
                    error={fileOpen.error}
                    onRefresh={() => { void loadFile(sessionId, path, { force: true }) }}
                    onAfterSelect={closeOpenWith}
                  />
                </div>
              ) : null}
            </span>
          </>
        ) : null}
      </div>

      <div data-testid="workspace-file-body" className="relative flex min-h-0 flex-1">
        <div key={viewKey} ref={fileContentRef} className="flex min-h-0 min-w-0 flex-1 flex-col" onScrollCapture={(event) => {
          const surface = event.target
          if (!(surface instanceof HTMLElement) || !surface.hasAttribute('data-workspace-scroll-surface')) return
          setConsumedReveal(revealKey)
          useWorkspaceContentStore.getState().setFileView(sessionId, path, {
            scrollTop: surface.scrollTop,
            scrollLeft: surface.scrollLeft,
            revealNonce: tab.reveal?.nonce,
          })
        }}>
          {!path ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
              <FolderOpen size={32} strokeWidth={1.7} aria-hidden="true" className="mb-1 text-[var(--color-text-tertiary)]" />
              <h3 className="text-[18px] font-medium text-[var(--color-text-primary)]">{t('workspace.files.openTitle')}</h3>
              <p className="text-[16px] text-[var(--color-text-tertiary)]">{t('workspace.files.pickAFile')}</p>
            </div>
          ) : !entry || entry.state === 'loading' ? (
            <PanelMessage icon="hourglass_empty" message={t('workspace.previewState.loading')} />
          ) : entry.state === 'missing' ? (
            <PanelMessage icon="search_off" message={t('workspace.previewState.missing')} />
          ) : entry.state === 'too_large' ? (
            <PanelMessage icon="database" message={t('workspace.previewState.tooLarge')} />
          ) : entry.state === 'binary' ? (
            <PanelMessage icon="data_object" message={t('workspace.previewState.binary')} />
          ) : entry.state === 'error' ? (
            <PanelMessage icon="error" tone="error" message={entry.error || t('workspace.loadError')} />
          ) : entry.previewType === 'image' ? (
            <ImagePreview dataUrl={entry.dataUrl} path={path} error={entry.error} />
          ) : isMarkdown(path) ? (
            <MarkdownSurface
              value={entry.content ?? ''}
              path={path}
              sessionId={sessionId}
              workDir={workDir}
              onAddSelection={addSelectionToChat}
            />
          ) : (
            <CodeSurface
              value={entry.content ?? ''}
              language={entry.language ?? 'text'}
              reveal={tab.reveal}
              revealScroll={revealScroll}
              onAddLineComment={addLineComment}
              onAddSelection={addSelectionToChat}
            />
          )}
          {entry?.refreshError ? (
            <p
              role="status"
              className="shrink-0 border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)]"
            >
              {t('workspace.files.refreshFailed', { reason: entry.refreshError })}
            </p>
          ) : null}
        </div>

      <WorkspaceTreeSidebar open={treeOpen} onOpenChange={setTreeOpen} collapseOnNarrow={!!path}>
          <WorkspaceFileTreePane
            sessionId={sessionId}
            selectedPath={path || null}
            autoFocus={!path}
            onOpen={(nextPath) =>
              // A pick from the tree is a permanent tab of its own. Only the
              // empty Files launcher this tree is hosted in gets replaced —
              // everything else adds, so ten picks mean ten tabs.
              workspaceOpen.file(sessionId, nextPath, { replaceBlankPlaceholder: true })}
          />
      </WorkspaceTreeSidebar>
      </div>
    </div>
  )
}
