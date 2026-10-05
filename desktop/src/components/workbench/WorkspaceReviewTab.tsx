import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Eye,
  ExternalLink,
  FolderClosed,
  FolderOpen,
  FolderX,
  Columns2,
  History,
  List,
  ListFilter,
  Plus,
  RefreshCw,
  Undo2,
  WrapText,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { CopyButton } from '@/components/ui/CopyButton'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { Input } from '@/components/ui/Input'
import { SearchField } from '@/components/ui/SearchField'
import { Spinner } from '@/components/ui/Spinner'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../i18n'
import { formatBytes } from '../../lib/formatBytes'
import { useWorkspaceChatContextStore } from '@/stores/workspaceChatContextStore'
import type { WorkspaceDiffCommentSelection } from '@/components/workspace/WorkspaceDiffSurface'
import type { WorkspaceDiffMode } from '@/components/workspace/workspaceDiffLayout'
import { WorkspaceDiffSurface } from '../workspace/WorkspaceDiffSurface'
import { PanelMessage } from '../workspace/surfaces/PanelMessage'
import { WorkspaceTreeSidebar } from '@/components/workbench/WorkspaceTreeSidebar'
import { parseWorkspaceDiff } from '@/components/workspace/workspaceDiffModel'
import { splitReviewHunks } from '@/lib/workspace/reviewHunks'
import { workspaceOpen } from '@/lib/workspace/openTarget'
import { useMenuKeyboard } from './menuKeyboard'
import { useRovingTree } from './treeKeyboard'
import { useWorkspaceReviewRefresh } from '@/lib/workspace/useWorkspaceReviewRefresh'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import {
  reviewSourceKey,
  type WorkspaceReviewSource,
  type WorkspaceReviewTab as WorkspaceReviewTabModel,
} from '../../lib/workspace/types'
import type { ReviewFile } from '../../api/review'

const REVIEW_MENU_ITEM = 'flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[13px] text-[var(--color-text-primary)] outline-none transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]'

/** A labelled action inside the floating bulk-action pill. */
const REVIEW_PILL_BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'

const SOURCE_OPTIONS: readonly WorkspaceReviewSource[] = [
  { kind: 'unstaged' },
  { kind: 'staged' },
  { kind: 'uncommitted' },
]

export type WorkspaceReviewTabProps = {
  active?: boolean
  sessionId: string
  tab: WorkspaceReviewTabModel
  /** Branch offered in the comparison picker, when the repo reports one. */
  defaultBranchRef?: string | null
}

/** One row of the change tree: a directory group, or a changed file. */
type ChangeRow = {
  path: string
  name: string
  depth: number
  isDirectory: boolean
  expanded: boolean
  file?: ReviewFile
}

type ChangeGroup = {
  name: string
  path: string
  directories: Map<string, ChangeGroup>
  files: ReviewFile[]
}

function emptyGroup(name: string, path: string): ChangeGroup {
  return { name, path, directories: new Map(), files: [] }
}

/**
 * Group the changed files by directory.
 *
 * A flat list of basenames cannot tell two `index.ts` apart, which is exactly
 * the shape a change set tends to have. The reference groups by directory, and
 * so does this.
 */
function buildChangeRows(files: readonly ReviewFile[], collapsed: ReadonlySet<string>): ChangeRow[] {
  const root = emptyGroup('', '')

  for (const file of files) {
    const segments = file.path.split('/')
    segments.pop()
    let group = root
    let prefix = ''
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      const existing = group.directories.get(segment) ?? emptyGroup(segment, prefix)
      group.directories.set(segment, existing)
      group = existing
    }
    group.files.push(file)
  }

  const rows: ChangeRow[] = []
  const walk = (group: ChangeGroup, depth: number) => {
    for (const directory of group.directories.values()) {
      const expanded = !collapsed.has(directory.path)
      rows.push({
        path: directory.path,
        name: directory.name,
        depth,
        isDirectory: true,
        expanded,
      })
      if (expanded) walk(directory, depth + 1)
    }
    for (const file of group.files) {
      rows.push({
        path: file.path,
        name: file.path.split('/').pop() ?? file.path,
        depth,
        isDirectory: false,
        expanded: false,
        file,
      })
    }
  }
  walk(root, 0)
  return rows
}

/**
 * The one-letter Git status shown in the change tree, coloured by what it
 * means for the reader: green adds, amber edits, red removals.
 */
function changeLetter(file: ReviewFile, untracked: boolean): { letter: string; tone: string } {
  if (untracked) return { letter: 'U', tone: 'text-[var(--color-success)]' }
  switch (file.status) {
    case 'added':
    case 'copied':
      return { letter: 'A', tone: 'text-[var(--color-success)]' }
    case 'deleted':
      return { letter: 'D', tone: 'text-[var(--color-error)]' }
    case 'renamed':
      return { letter: 'R', tone: 'text-[var(--color-info)]' }
    default:
      return { letter: file.staged && !file.unstaged ? 'S' : 'M', tone: 'text-[var(--color-warning)]' }
  }
}

/** Split a path so the ellipsis can eat the front and leave the filename whole. */
function splitForStartTruncation(value: string): { head: string; tail: string } {
  const cut = value.lastIndexOf('/')
  if (cut < 0) return { head: '', tail: value }
  return { head: value.slice(0, cut), tail: value.slice(cut + 1) }
}

function useSourceLabel() {
  const t = useTranslation()
  return useCallback((source: WorkspaceReviewSource) => {
    switch (source.kind) {
      case 'unstaged':
        return t('workspace.review.sourceUnstaged')
      case 'staged':
        return t('workspace.review.sourceStaged')
      case 'uncommitted':
        return t('workspace.review.sourceUncommitted')
      case 'branch':
        return t('workspace.review.sourceBranch', { ref: source.baseRef })
      case 'turn':
        return t('workspace.review.sourceTurn')
      case 'commit':
        return t('workspace.review.sourceCommit', { sha: source.commit.slice(0, 8) })
    }
  }, [t])
}

/**
 * Git review: an explicit comparison, its change tree, and real index and
 * working-tree operations.
 *
 * Every write carries the snapshot the user was looking at. A `stale` answer
 * means nothing was applied — the banner asks for a refresh rather than
 * retrying, because a silent retry would apply a hunk to content that has
 * changed since it was read.
 */
export function WorkspaceReviewTab({
  sessionId,
  tab,
  defaultBranchRef,
  active = true,
}: WorkspaceReviewTabProps) {
  const t = useTranslation()
  const sourceLabel = useSourceLabel()
  const [diffMode, setDiffMode] = useState<WorkspaceDiffMode>('unified')
  const [wrapLines, setWrapLines] = useState(false)
  // Expansion is an in-memory reading preference, scoped to the comparison.
  // Viewed files default to closed but can still be reopened without unmarking.
  const [openByScope, setOpenByScope] = useState<Record<string, Record<string, boolean>>>({})
  const [treeOpen, setTreeOpen] = useState(true)
  const [filter, setFilter] = useState('')
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [refEditor, setRefEditor] = useState<'branch' | 'commit' | null>(null)
  const [refValue, setRefValue] = useState('')
  const [refError, setRefError] = useState<string | null>(null)
  const [refSubmitting, setRefSubmitting] = useState(false)
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingRevert, setPendingRevert] = useState<string[] | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const sourceMenuRef = useRef<HTMLDivElement>(null)
  const sourceTriggerRef = useRef<HTMLButtonElement>(null)
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const locatedRequest = useRef<string | null>(null)
  const fieldIds = useId()

  const source = tab.source
  useWorkspaceReviewRefresh(sessionId, source, active)
  const reviewScope = JSON.stringify([sessionId, tab.id, reviewSourceKey(source)])
  const setFileOpen = useCallback((path: string, open: boolean | undefined) => {
    setOpenByScope(current => {
      if (current[reviewScope]?.[path] === open) return current
      const overrides = { ...current[reviewScope] }
      if (open === undefined) delete overrides[path]
      else overrides[path] = open
      return { ...current, [reviewScope]: overrides }
    })
  }, [reviewScope])
  const selectedPath = tab.selectedPath
  const entry = useWorkspaceReviewStore((state) => state.getEntry(sessionId, source))
  const load = useWorkspaceReviewStore((state) => state.load)
  const loadDiff = useWorkspaceReviewStore((state) => state.loadDiff)
  const writable = !entry.readOnly
  // Computed from the status already on screen, before the write: a deletion of
  // an untracked file is the one revert outcome Git cannot undo, so the dialog
  // has to say so and name the files rather than promising a recoverable copy.
  const revertPlan = useMemo(
    () => useWorkspaceReviewStore.getState().describeRevert(sessionId, source, pendingRevert ?? []),
    [pendingRevert, sessionId, source],
  )

  const closeSourceMenu = useCallback(() => setSourceMenuOpen(false), [])
  const closeRefEditor = useCallback(() => {
    setRefEditor(null)
    sourceTriggerRef.current?.focus()
  }, [])

  const editRef = (kind: 'branch' | 'commit') => {
    setRefValue(kind === 'branch'
      ? source.kind === 'branch' ? source.baseRef : defaultBranchRef ?? ''
      : source.kind === 'commit' ? source.commit : '')
    setRefError(null)
    setSourceMenuOpen(false)
    setRefEditor(kind)
  }

  const submitRef = async () => {
    if (!refEditor || refSubmitting) return
    const value = refValue.trim()
    if (!value) {
      setRefError(t('workspace.review.refRequired'))
      return
    }
    const nextSource: WorkspaceReviewSource = refEditor === 'branch'
      ? { kind: 'branch', baseRef: value }
      : { kind: 'commit', commit: value }
    setRefSubmitting(true)
    setRefError(null)
    try {
      // The existing status endpoint resolves and validates Git refs. Keep the
      // current comparison visible until the requested one can actually load.
      const store = useWorkspaceReviewStore.getState()
      await store.load(sessionId, nextSource, { force: true })
      const result = store.getEntry(sessionId, nextSource)
      if (result.error || result.status?.state !== 'ok') {
        setRefError(result.error ?? t('workspace.review.refUnavailable'))
        return
      }
      useWorkspaceStore.getState().setReviewSource(sessionId, tab.id, nextSource)
      closeRefEditor()
    } finally {
      setRefSubmitting(false)
    }
  }

  useDismissable({
    open: sourceMenuOpen,
    refs: [sourceMenuRef, sourceTriggerRef],
    onDismiss: closeSourceMenu,
  })

  const handleSourceMenuKeyDown = useMenuKeyboard({
    open: sourceMenuOpen,
    menuRef: sourceMenuRef,
    triggerRef: sourceTriggerRef,
    onClose: closeSourceMenu,
  })

  useEffect(() => {
    const saved = useWorkspaceStore.getState().getTab(sessionId, tab.id)
    if (saved?.kind === 'review' && saved.viewedPaths) useWorkspaceReviewStore.getState().restoreViewed(sessionId, source, saved.viewedPaths, saved.viewedSnapshot)
    void load(sessionId, source)
  }, [load, sessionId, source, tab.id])

  useEffect(() => {
    if (entry.status && !entry.loading) useWorkspaceStore.getState().setReviewViewedPaths(sessionId, tab.id, entry.viewedPaths, entry.viewedSnapshot ?? undefined)
  }, [entry.status, entry.loading, entry.viewedPaths, entry.viewedSnapshot, sessionId, tab.id])

  const files = entry.status?.files ?? []
  const untracked = useMemo(() => new Set(entry.status?.untracked ?? []), [entry.status])

  /**
   * The typed query narrows the content; the change-tree selection does not.
   *
   * Selecting a file used to filter every other section out of the panel, which
   * turned "take me to this file" into "hide the rest of the review" — the diff
   * above and below the selection is most of what a review is for. Spec §4.3
   * asks for 单文件定位: locate it, keep it mounted next to its neighbours.
   */
  const visibleFiles = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return query ? files.filter((file) => file.path.toLowerCase().includes(query)) : files
  }, [files, filter])

  // Requested per section as it scrolls into view. Fetching every file on mount
  // meant a 200-file review issued 200 requests at once, each spawning several
  // `git` processes.
  const requestDiff = useCallback((file: ReviewFile) => {
    if (file.binary || file.conflicted || file.statsTruncated) return
    void loadDiff(sessionId, source, file.path, file.oldPath)
  }, [loadDiff, sessionId, source])

  const locate = useCallback((path: string) => {
    setFileOpen(path, true)
    // jsdom implements no scrolling at all, and a section can be unmounted by
    // an in-flight filter, so both the node and the method are optional.
    const section = sectionRefs.current.get(path)
    section?.scrollIntoView?.({ block: 'start' })
    return !!section
  }, [setFileOpen])

  useEffect(() => {
    if (!selectedPath) {
      locatedRequest.current = null
      return
    }
    const request = JSON.stringify([sessionId, tab.id, reviewSourceKey(source), selectedPath])
    if (locatedRequest.current !== request && locate(selectedPath)) locatedRequest.current = request
  }, [locate, selectedPath, entry.status, visibleFiles, sessionId, source, tab.id])

  const runWrite = useCallback(async (
    operation: 'stage' | 'unstage' | 'revert',
    paths: string[],
  ) => {
    setOperationError(null)
    const result = await useWorkspaceReviewStore.getState()[operation](sessionId, source, paths)
    if (result.state === 'refused') {
      // A refusal used to be a silent `null`: the button moved and nothing
      // happened, with no way to tell whether it had worked.
      if (result.refusal === 'no_paths') return
      setOperationError(t(result.refusal === 'no_snapshot'
        ? 'workspace.review.refusedNoSnapshot'
        : 'workspace.review.readOnlySource'))
      return
    }
    if (result.state === 'stale') return
    const failed = result.results.filter((item) => !item.ok)
    if (failed.length > 0) {
      setOperationError(t('workspace.review.failed', {
        reason: failed.map((item) => `${item.path}: ${item.error ?? ''}`).join('; '),
      }))
    }
  }, [sessionId, source, t])

  const sourceOptions = useMemo(() => (
    defaultBranchRef
      ? [...SOURCE_OPTIONS, { kind: 'branch', baseRef: defaultBranchRef } as WorkspaceReviewSource]
      : SOURCE_OPTIONS
  ), [defaultBranchRef])

  const changeRows = useMemo(
    () => buildChangeRows(visibleFiles, collapsedDirs),
    [collapsedDirs, visibleFiles],
  )

  const toggleDirectory = useCallback((path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const selectFile = useCallback((path: string) => {
    // Always select rather than toggle: with the content no longer filtered,
    // clicking a row again means "take me back there".
    useWorkspaceStore.getState().setReviewSelectedPath(sessionId, tab.id, path)
    locate(path)
  }, [locate, sessionId, tab.id])

  const {
    activePath,
    handleKeyDown: handleTreeKeyDown,
    registerRow,
    setFocusedPath,
  } = useRovingTree(changeRows, {
    selectedPath,
    onActivate: (row) => {
      if (row.isDirectory) toggleDirectory(row.path)
      else selectFile(row.path)
    },
    onToggleDirectory: (row) => toggleDirectory(row.path),
  })

  const totals = entry.status?.totals

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        data-testid="workspace-review-toolbar"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] pl-3 pr-2"
      >
        <span className="relative shrink-0">
          <button
            ref={sourceTriggerRef}
            type="button"
            data-testid="workspace-review-source"
            /*
              `aria-label` used to sit here and overrode the visible text, so
              the control announced "Comparison" and never which comparison.
              Labelling by reference keeps both halves.
            */
            aria-labelledby={`${fieldIds}-source-label ${fieldIds}-source-value`}
            aria-haspopup="menu"
            aria-expanded={sourceMenuOpen}
            onClick={() => setSourceMenuOpen((open) => !open)}
            className="flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] pl-2.5 pr-2 text-[12px] text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            <span id={`${fieldIds}-source-label`} className="sr-only">
              {t('workspace.review.sourceLabel')}
            </span>
            <span id={`${fieldIds}-source-value`}>{sourceLabel(source)}</span>
            <ChevronDown size={12} strokeWidth={2} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />
          </button>
          {sourceMenuOpen ? (
            <div
              ref={sourceMenuRef}
              role="menu"
              aria-label={t('workspace.review.sourceLabel')}
              onKeyDown={handleSourceMenuKeyDown}
              className="absolute left-0 top-8 z-[var(--z-dropdown)] min-w-[200px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-dropdown)]"
            >
              {sourceOptions.map((option) => {
                const current = reviewSourceKey(option) === reviewSourceKey(source)
                return (
                  <button
                    key={`${option.kind}-${'baseRef' in option ? option.baseRef : ''}`}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSourceMenuOpen(false)
                      useWorkspaceStore.getState().setReviewSource(sessionId, tab.id, option)
                    }}
                    className={`${REVIEW_MENU_ITEM} ${current ? 'bg-[var(--color-surface-hover)]' : ''}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{sourceLabel(option)}</span>
                    {current ? <Check size={14} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--color-brand)]" /> : null}
                  </button>
                )
              })}
              <div role="separator" className="-mx-1 my-1 border-t border-[var(--color-border)]" />
              {(['branch', 'commit'] as const).map(kind => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  onClick={() => editRef(kind)}
                  className={REVIEW_MENU_ITEM}
                >
                  <span className="min-w-0 flex-1 truncate">{t(kind === 'branch' ? 'workspace.review.compareBranch' : 'workspace.review.viewCommit')}</span>
                </button>
              ))}
            </div>
          ) : null}
        </span>

        <ActionDialog
          open={refEditor !== null}
          onClose={closeRefEditor}
          title={t(refEditor === 'branch' ? 'workspace.review.compareBranch' : 'workspace.review.viewCommit')}
          width={420}
          loading={refSubmitting}
          body={(
            <Input
              label={t(refEditor === 'branch' ? 'workspace.review.branchReference' : 'workspace.review.commitReference')}
              value={refValue}
              placeholder={refEditor === 'branch' ? 'feature/base' : 'HEAD~1'}
              error={refError ?? undefined}
              disabled={refSubmitting}
              autoComplete="off"
              spellCheck={false}
              onChange={event => { setRefValue(event.target.value); setRefError(null) }}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void submitRef()
                }
              }}
            />
          )}
          actions={[
            { label: t('common.cancel'), onClick: closeRefEditor },
            { label: t('workspace.review.compare'), onClick: submitRef, variant: 'primary', loading: refSubmitting },
          ]}
        />

        {totals ? (
          <span className="flex shrink-0 items-center gap-2 text-[12px]">
            <span className="font-mono tabular-nums">
              <span className="text-[var(--color-diff-added-text)]">+{totals.additions}</span>
              {' '}
              <span className="text-[var(--color-diff-removed-text)]">-{totals.deletions}</span>
            </span>
            <span data-testid="workspace-review-file-count" className="text-[var(--color-text-tertiary)]">
              {t('workspace.review.fileCount', { count: totals.files })}
            </span>
          </span>
        ) : null}
        {entry.status?.source.resolvedBase ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
            {t('workspace.review.resolvedBase', {
              ref: entry.status.source.resolvedBase.slice(0, 10),
            })}
          </span>
        ) : null}

        <span className="ml-auto flex shrink-0 items-center gap-1">
          <SegmentedControl<WorkspaceDiffMode>
            size="sm"
            label={t('workspace.review.diffLayout')}
            value={diffMode}
            onChange={setDiffMode}
            items={[
              { value: 'unified', title: t('workspace.review.unified'), icon: <List size={14} strokeWidth={1.75} aria-hidden="true" />, label: <span className="sr-only">{t('workspace.review.unified')}</span> },
              { value: 'split', title: t('workspace.review.split'), icon: <Columns2 size={14} strokeWidth={1.75} aria-hidden="true" />, label: <span className="sr-only">{t('workspace.review.split')}</span> },
            ]}
          />
          <IconButton icon={<WrapText size={14} strokeWidth={1.75} />} label={t(wrapLines ? 'workspace.review.disableWrap' : 'workspace.review.enableWrap')} pressed={wrapLines} size="sm" tone="muted" onClick={() => setWrapLines(wrap => !wrap)} />
          <IconButton icon={treeOpen ? <FolderOpen size={14} strokeWidth={1.75} /> : <FolderClosed size={14} strokeWidth={1.75} />} label={t('workspace.files.toggleTree')} size="sm" tone="muted" pressed={treeOpen} onClick={() => setTreeOpen(open => !open)} />
          <IconButton
            icon={<RefreshCw size={14} strokeWidth={1.75} />}
            label={t('workspace.review.refresh')}
            size="sm"
            tone="muted"
            data-testid="workspace-review-refresh"
            onClick={() => { void load(sessionId, source, { force: true }) }}
          />
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {entry.stale ? (
            <p
              role="alert"
              data-testid="workspace-review-stale"
              className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-warning-container)] px-3 py-1.5 text-[12px] text-[var(--color-on-warning-container)]"
            >
              {t('workspace.review.stale')}
            </p>
          ) : null}
          {operationError ? (
            <p
              role="alert"
              className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-error-container)] px-3 py-1.5 text-[12px] text-[var(--color-on-error-container)]"
            >
              {operationError}
            </p>
          ) : null}
          {entry.lastDeletedPaths.length > 0 ? (
            <p
              role="status"
              className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-warning-container)] px-3 py-1.5 text-[12px] text-[var(--color-on-warning-container)]"
            >
              {t('workspace.review.revertDeleted', {
                count: entry.lastDeletedPaths.length,
                path: entry.lastBackupDir ?? '',
              })}
            </p>
          ) : null}
          {entry.lastBackupDir ? (
            <p className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-tertiary)]">
              {t('workspace.review.backupSaved', { path: entry.lastBackupDir })}
            </p>
          ) : null}

          {/* The cards scroll vertically here; each card's diff scrolls sideways
              on its own so a long line never pushes the card frames apart. */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden p-3 pb-20">
            {entry.loading && !entry.status ? (
              <div className="flex items-center justify-center py-8">
                <Spinner size={18} label={t('common.loading')} />
              </div>
            ) : entry.status?.state === 'not_git_repo' ? (
              <PanelMessage icon={FolderX} message={t('workspace.review.notGitRepo')} />
            ) : entry.status?.state === 'missing_workdir' ? (
              <PanelMessage icon={FolderX} tone="error" message={t('workspace.review.missingWorkdir')} />
            ) : entry.status?.state === 'no_head' ? (
              <PanelMessage icon={History} message={t('workspace.review.noHead')} />
            ) : entry.error ? (
              <PanelMessage icon={CircleAlert} tone="error" message={source.kind === 'turn' ? t('workspace.review.historyUnavailable') : entry.error} />
            ) : visibleFiles.length === 0 ? (
              <PanelMessage icon={CircleCheck} message={t('workspace.review.empty')} />
            ) : (
              visibleFiles.map((file) => (
                <ReviewFileSection
                  key={`${reviewScope}:${file.path}`}
                  file={file}
                  diffMode={diffMode}
                  wrapLines={wrapLines}
                  open={openByScope[reviewScope]?.[file.path] ?? !entry.viewedPaths.includes(file.path)}
                  onToggleOpen={() => setFileOpen(file.path, !(openByScope[reviewScope]?.[file.path] ?? !entry.viewedPaths.includes(file.path)))}
                  onOpenFile={line => workspaceOpen.file(sessionId, file.path, { line, preview: false })}
                  onAddComment={(selection, note) => useWorkspaceChatContextStore.getState().addReference(sessionId, {
                    kind: 'code-comment', path: file.path, name: file.path.split('/').pop() ?? file.path,
                    diffSide: selection.side, lineStart: selection.lineStart, lineEnd: selection.lineEnd,
                    hunkId: `${reviewSourceKey(source)}:${selection.hunkId}`, quote: selection.quote, note,
                    ...(source.kind === 'turn' ? { messageId: source.turnKey } : {}),
                  })}
                  registerSection={(node) => {
                    if (node) sectionRefs.current.set(file.path, node)
                    else sectionRefs.current.delete(file.path)
                  }}
                  untracked={untracked.has(file.path)}
                  writable={writable && !entry.stale && !entry.loading}
                  source={source}
                  viewed={entry.viewedPaths.includes(file.path)}
                  diff={entry.diffsByPath[file.path]?.diff}
                  diffUnavailable={entry.diffsByPath[file.path]?.state === 'missing' || entry.diffsByPath[file.path]?.state === 'error'}
                  diffTruncated={entry.diffsByPath[file.path]?.truncated}
                  diffBytes={entry.diffsByPath[file.path]?.bytes}
                  diffLoading={entry.diffLoadingByPath[file.path] === true}
                  onReachedView={() => requestDiff(file)}
                  onStage={() => { void runWrite('stage', [file.path]) }}
                  onUnstage={() => { void runWrite('unstage', [file.path]) }}
                  onRevert={() => setPendingRevert([file.path])}
                  onHunk={async (patch) => {
                    const result = await useWorkspaceReviewStore.getState()[source.kind === 'staged' ? 'unstageHunk' : 'stageHunk'](sessionId, source, patch)
                    if (result.state !== 'stale' && result.state !== 'refused' && result.error) setOperationError(result.error)
                  }}
                  onToggleViewed={() => {
                    // Let the viewed mark supply the default so a new snapshot
                    // that invalidates that mark also reveals the changed diff.
                    setFileOpen(file.path, undefined)
                    const store = useWorkspaceReviewStore.getState()
                    store.toggleViewed(sessionId, source, file.path)
                    useWorkspaceStore.getState().setReviewViewedPaths(sessionId, tab.id, store.getEntry(sessionId, source).viewedPaths, store.getEntry(sessionId, source).viewedSnapshot ?? undefined)
                  }}
                />
              ))
            )}
          </div>

          {/* Keep labelled bulk actions over the preview; scrolling code retains
              the full canvas height and the change tree remains unobstructed. */}
          {writable && files.length > 0 ? (
            <div
              data-testid="workspace-review-bulk-bar"
              className="absolute bottom-4 left-1/2 z-[var(--z-sticky)] flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-[3px] shadow-[var(--shadow-dropdown)]"
            >
              {source.kind !== 'staged' ? <>
                <button
                  type="button"
                  data-testid="workspace-review-revert-all"
                  disabled={entry.stale || entry.loading}
                  onClick={() => setPendingRevert(
                    // Untracked files are deliberately excluded: a bulk discard
                    // must not delete files Git has never seen.
                    files.filter((file) => !untracked.has(file.path)).map((file) => file.path),
                  )}
                  className={REVIEW_PILL_BUTTON}
                >
                  <Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t('workspace.review.revertAll')}
                </button>
                <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-[var(--color-border)]" />
              </> : null}
              <button
                type="button"
                data-testid={source.kind === 'staged' ? 'workspace-review-unstage-all' : 'workspace-review-stage-all'}
                disabled={entry.stale || entry.loading}
                onClick={() => { void runWrite(source.kind === 'staged' ? 'unstage' : 'stage', files.map((file) => file.path)) }}
                className={REVIEW_PILL_BUTTON}
              >
                <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
                {t(source.kind === 'staged' ? 'workspace.review.unstageAll' : 'workspace.review.stageAll')}
              </button>
            </div>
          ) : null}
        </div>

        <WorkspaceTreeSidebar open={treeOpen} onOpenChange={setTreeOpen}>
          <div className="flex min-h-0 flex-1 flex-col border-l border-[var(--color-border)]">
          <div className="shrink-0 px-2 pb-2 pt-2.5">
            <SearchField
              value={filter}
              onChange={setFilter}
              size="sm"
              icon={<ListFilter size={14} strokeWidth={1.75} aria-hidden="true" />}
              label={t('workspace.review.filterFiles')}
              placeholder={t('workspace.review.filterFiles')}
              clearLabel={t('workspace.clearFilter')}
              data-testid="workspace-review-filter"
            />
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto px-2 pb-2"
            role="tree"
            aria-label={t('workspace.review.changeTree')}
          >
            {changeRows.map((row) => {
              const selected = !row.isDirectory && selectedPath === row.path
              return (
                <div
                  key={row.path}
                  ref={registerRow(row.path)}
                  role="treeitem"
                  tabIndex={row.path === activePath ? 0 : -1}
                  aria-level={row.depth + 1}
                  aria-expanded={row.isDirectory ? row.expanded : undefined}
                  aria-selected={row.isDirectory ? undefined : selected}
                  // The selection locates a section rather than filtering the
                  // panel, so it is "the one you are looking at", not "the one
                  // shown".
                  aria-current={selected ? 'true' : undefined}
                  data-testid={row.isDirectory
                    ? `workspace-review-dir-${row.path}`
                    : `workspace-review-file-${row.path}`}
                  onFocus={() => setFocusedPath(row.path)}
                  onClick={() => {
                    setFocusedPath(row.path)
                    if (row.isDirectory) toggleDirectory(row.path)
                    else selectFile(row.path)
                  }}
                  onKeyDown={(event) => handleTreeKeyDown(event, row)}
                  style={{ paddingLeft: 2 + row.depth * 16 }}
                  className={[
                    'flex h-[26px] cursor-default items-center gap-1.5 rounded-[var(--radius-xs)] pr-1.5 text-left text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]',
                    selected
                      ? 'bg-[var(--color-surface-selected)] font-medium text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
                  ].join(' ')}
                >
                  {row.isDirectory ? (
                    <>
                      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--color-text-tertiary)]">
                        {row.expanded
                          ? <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
                          : <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />}
                      </span>
                      {row.expanded
                        ? <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                        : <FolderClosed size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />}
                    </>
                  ) : row.file ? (() => {
                    const { letter, tone } = changeLetter(row.file, untracked.has(row.file.path))
                    return (
                      <span data-testid={`workspace-review-status-${row.path}`} className={`flex w-3.5 shrink-0 justify-center font-mono text-[11px] font-medium ${tone}`}>
                        {letter}
                      </span>
                    )
                  })() : null}
                  <span className="min-w-0 flex-1 truncate" title={row.path}>
                    {row.name}
                  </span>
                  {row.file?.conflicted ? (
                    <Circle size={8} aria-hidden="true" className="shrink-0 fill-[var(--color-error)] text-[var(--color-error)]" />
                  ) : null}
                </div>
              )
            })}
          </div>
          </div>
        </WorkspaceTreeSidebar>
      </div>

      <ConfirmDialog
        open={pendingRevert !== null}
        onClose={() => setPendingRevert(null)}
        onConfirm={async () => {
          const paths = pendingRevert
          setPendingRevert(null)
          if (paths) await runWrite('revert', paths)
        }}
        title={revertPlan.deletePaths.length > 0
          ? t('workspace.review.revertDeleteTitle')
          : t('workspace.review.revertTitle')}
        body={revertPlan.deletePaths.length > 0
          ? [
              t('workspace.review.revertDeleteBody', { count: revertPlan.deletePaths.length }),
              t('workspace.review.revertDeleteList', { paths: revertPlan.deletePaths.join(', ') }),
              revertPlan.revertPaths.length > 0
                ? t('workspace.review.revertTrackedBody', { count: revertPlan.revertPaths.length })
                : '',
            ].filter(Boolean).join('\n')
          : [
              t('workspace.review.revertBody', { count: revertPlan.revertPaths.length }),
              t('workspace.review.revertUntrackedWarning'),
            ].join('\n')}
        confirmLabel={t('workspace.review.revert')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
      />
    </div>
  )
}

function ReviewFileSection({
  file,
  registerSection,
  untracked,
  writable,
  source,
  viewed,
  diff,
  diffTruncated,
  diffUnavailable,
  diffBytes,
  diffLoading,
  onReachedView,
  onStage,
  onUnstage,
  onRevert,
  onToggleViewed,
  onHunk,
  diffMode,
  wrapLines,
  open,
  onToggleOpen,
  onOpenFile,
  onAddComment,
}: {
  file: ReviewFile
  registerSection: (node: HTMLElement | null) => void
  untracked: boolean
  writable: boolean
  source: WorkspaceReviewSource
  viewed: boolean
  diff?: string
  /** The file was past the diff cap; `diff` is a header with no hunk. */
  diffTruncated?: boolean
  diffUnavailable?: boolean
  diffBytes?: number
  diffLoading: boolean
  onReachedView: () => void
  onStage: () => void
  onUnstage: () => void
  onRevert: () => void
  onToggleViewed: () => void
  onHunk: (patch: string) => Promise<void>
  diffMode: WorkspaceDiffMode
  wrapLines: boolean
  open: boolean
  onToggleOpen: () => void
  onOpenFile: (line: number) => void
  onAddComment: (selection: WorkspaceDiffCommentSelection, note: string) => void
}) {
  const t = useTranslation()
  const unstage = source.kind === 'staged' || (source.kind === 'uncommitted' && file.staged && !file.unstaged)
  const hunks = useMemo(() => diff && !file.oldPath && !file.binary && !file.conflicted && !diffTruncated && (source.kind === 'staged' || source.kind === 'unstaged') ? splitReviewHunks(diff) : [], [diff, diffTruncated, file.oldPath, file.binary, file.conflicted, source.kind])
  const [hunkPending, setHunkPending] = useState(false)
  const display = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
  const { head, tail } = splitForStartTruncation(display)
  const sectionRef = useRef<HTMLElement | null>(null)
  const contentId = useId()
  const firstChangeLine = useMemo(() => {
    const rows = parseWorkspaceDiff(diff ?? '').flatMap(item => item.rows)
    return rows.find(row => row.kind === 'addition')?.newLine
      ?? rows.find(row => row.kind === 'deletion')?.oldLine
      ?? 1
  }, [diff])

  // Ask for this file's diff when its section reaches the screen. Fetching every
  // file on mount meant a 200-file review issued 200 requests at once, each
  // spawning several `git` processes.
  useEffect(() => {
    const element = sectionRef.current
    if (!element || !open) return
    // jsdom has no IntersectionObserver; requesting immediately there keeps the
    // component testable without pretending the browser path ran.
    if (typeof IntersectionObserver !== 'function') {
      onReachedView()
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      onReachedView()
      observer.disconnect()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [onReachedView, open])

  return (
    <section
      ref={(node) => {
        sectionRef.current = node
        registerSection(node)
      }}
      data-testid={`workspace-review-section-${file.path}`}
      // `overflow-clip`, not `overflow-hidden`: the rounded frame must clip its
      // corners without becoming the scroll box its sticky header pins against.
      className="shrink-0 overflow-clip rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <header className={`sticky top-0 z-[var(--z-sticky)] flex h-9 items-center gap-2 bg-[var(--color-surface-container)] pl-1.5 pr-1.5 ${open ? 'border-b border-[var(--color-border)]' : ''}`}>
        <IconButton
          icon={open ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
          label={t(open ? 'workspace.review.collapseFile' : 'workspace.review.expandFile')}
          aria-expanded={open}
          aria-controls={contentId}
          size="xs"
          tone="muted"
          onClick={onToggleOpen}
        />
        <span
          data-testid={`workspace-review-path-${file.path}`}
          className="flex min-w-0 flex-1 items-center font-mono text-[12px] text-[var(--color-text-primary)]"
          title={display}
        >
          {head ? (
            /*
              Ellipsise the *front*. Trailing truncation cut off the filename —
              the one part of a path that identifies what is on screen — so a
              long path read as ".agent-teams/archive/ui-back…". R4 keeps the
              tail: "...w/inbox/captain.jsonl".
            */
            <span
              data-testid={`workspace-review-path-head-${file.path}`}
              dir="rtl"
              className="min-w-0 truncate text-left text-[var(--color-text-tertiary)]"
            >
              {/*
                The RTL box is what moves the ellipsis to the front; the inner
                LTR isolate is what keeps the path itself in order. Without it
                the bidi algorithm hands a leading neutral — the dot of
                `.agent-teams` — to the paragraph direction and renders it at
                the far end.
              */}
              <span dir="ltr">{head}</span>
            </span>
          ) : null}
          <span data-testid={`workspace-review-path-tail-${file.path}`} className="shrink-0 font-medium">
            {head ? `/${tail}` : tail}
          </span>
        </span>
        {untracked ? (
          <Badge tone="success" size="sm" className="shrink-0">{t('workspace.review.untracked')}</Badge>
        ) : file.status === 'added' ? (
          <Badge tone="success" size="sm" className="shrink-0">{t('workspace.review.newFile')}</Badge>
        ) : null}
        {file.statsTruncated ? (
          <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
            {t('workspace.review.statsTruncated')}
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[12px] tabular-nums">
            <span className="text-[var(--color-diff-added-text)]">+{file.additions}</span>
            {' '}
            <span className="text-[var(--color-diff-removed-text)]">-{file.deletions}</span>
          </span>
        )}
        {/* The actions never shrink: the path gives up its head first. */}
        <span className="ml-auto flex shrink-0 items-center">
          <CopyButton
            text={file.path}
            label={t('openWith.copyPath')}
            copiedLabel={t('common.copied')}
            displayLabel={<Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
            displayCopiedLabel={<Check size={14} strokeWidth={1.75} aria-hidden="true" />}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          />
          <IconButton
            icon={<ExternalLink size={14} strokeWidth={1.75} />}
            label={t('workspace.review.openFile')}
            size="xs"
            tone="muted"
            disabled={file.status === 'deleted'}
            onClick={() => onOpenFile(firstChangeLine)}
          />
          <IconButton
            icon={<Eye size={14} strokeWidth={1.75} />}
            label={t(viewed ? 'workspace.review.viewed' : 'workspace.review.markViewed')}
            size="xs"
            tone="muted"
            pressed={viewed}
            onClick={onToggleViewed}
          />
          {writable ? (
            <>
              {source.kind !== 'staged' ? <IconButton
                icon={<Undo2 size={14} strokeWidth={1.75} />}
                label={t('workspace.review.revert')}
                size="xs"
                tone="muted"
                hoverTone="danger"
                onClick={onRevert}
              /> : null}
              <IconButton
                icon={<Plus size={14} strokeWidth={1.75} />}
                label={t(unstage ? 'workspace.review.unstage' : 'workspace.review.stage')}
                size="xs"
                tone="muted"
                onClick={unstage ? onUnstage : onStage}
              />
            </>
          ) : null}
        </span>
      </header>

      {open ? <div id={contentId}>{file.conflicted ? (
        <p className="px-3 py-2.5 text-[12px] text-[var(--color-text-tertiary)]">
          {t('workspace.review.conflicted')}
        </p>
      ) : file.binary ? (
        <p className="px-3 py-2.5 text-[12px] text-[var(--color-text-tertiary)]">
          {t('workspace.review.binary')}
        </p>
      ) : diffTruncated ? (
        <p className="px-3 py-2.5 text-[12px] text-[var(--color-text-tertiary)]">
          {t('workspace.review.diffTruncated', { size: formatBytes(diffBytes ?? 0) })}
        </p>
      ) : diffUnavailable ? (
        <p role="alert" className="px-3 py-2.5 text-[12px] text-[var(--color-text-tertiary)]">{t('workspace.review.historyUnavailable')}</p>
      ) : diffLoading ? (
        <div className="flex items-center justify-center py-4">
          <Spinner size={14} label={t('common.loading')} />
        </div>
      ) : diff ? (
        <WorkspaceDiffSurface
          mode={diffMode}
          wrapLines={wrapLines}
          compactHunks
          hunkAction={writable && hunks.length > 0 ? {
            label: t(source.kind === 'staged' ? 'workspace.review.unstageHunk' : 'workspace.review.stageHunk'),
            disabled: hunkPending,
            onApply: index => {
              const hunk = hunks[index]
              if (!hunk || hunkPending) return
              setHunkPending(true)
              void onHunk(hunk.patch).finally(() => setHunkPending(false))
            },
          } : undefined}
          onAddComment={onAddComment}
          value={diff}
          path={file.path}
          hideSingleFileHeader
          // Sideways only: the gutter buttons' enlarged hit areas poke a few px
          // below the last row and must not grow a vertical scrollbar.
          className="overflow-x-auto overflow-y-hidden bg-[var(--color-surface)]"
        />
      ) : null}</div> : null}
    </section>
  )
}
