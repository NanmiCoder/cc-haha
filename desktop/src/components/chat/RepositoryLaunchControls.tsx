import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderGit2,
  GitBranch,
  GitFork,
  Loader2,
  Plus,
  Search,
} from 'lucide-react'
import {
  sessionsApi,
  type RepositoryBranchInfo,
  type RepositoryContextResult,
} from '../../api/sessions'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { setProjectDisplayName, useProjectDisplayName } from '../../stores/projectDisplayNameStore'
import { RecentProjectsPanel } from '@/components/composite/DirectoryPicker'
import {
  ProjectEditorModal,
  type ProjectEditorSubmission,
} from '@/components/layout/ProjectEditorModal'
import { invalidateRecentProjectsCache } from '../../lib/recentProjectsCache'
import { useDismissable } from '@/hooks/useDismissable'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'

type Props = {
  workDir: string
  onWorkDirChange: (path: string) => void
  branch: string | null
  onBranchChange: (branch: string | null) => void
  useWorktree: boolean
  onUseWorktreeChange: (enabled: boolean) => void
  onLaunchReadyChange?: (ready: boolean) => void
  disabled?: boolean
  /**
   * `toolbar` sits inside the composer's control row and shares its 36px
   * rhythm; `outside` is the standalone line below the composer, sized for
   * touch. Both render the same single pill — only the metrics differ.
   */
  placement?: 'toolbar' | 'outside'
}

const MENU_WIDTH = 400
const VIEWPORT_GUTTER = 12

/**
 * `root` lists directory, branch and the worktree modes; `directory` and
 * `branch` are its two drill-downs. The menu opens on `root` only when there
 * is a repo to describe — see `viewOnOpen`. `newBranch` is reached from the
 * branch list; cancelling returns there, while success closes the menu so the
 * newly selected branch is immediately visible in the pill.
 */
type MenuView = 'directory' | 'root' | 'branch' | 'newBranch'

/** Approximate heights, used only to decide whether the menu flips upward. */
const VIEW_HEIGHTS: Record<MenuView, number> = {
  directory: 380,
  root: 340,
  branch: 400,
  newBranch: 240,
}

/**
 * Server codes the create-branch form can explain in the user's own language.
 * Anything else falls through to the generic failure plus the raw git message,
 * which is more use than a translated shrug.
 */
const BRANCH_CREATE_ERROR_KEYS = {
  REPOSITORY_BRANCH_NAME_INVALID: 'repoLaunch.newBranchErrorInvalid',
  REPOSITORY_BRANCH_EXISTS: 'repoLaunch.newBranchErrorExists',
  REPOSITORY_NO_COMMITS: 'repoLaunch.newBranchErrorNoCommits',
} as const

/** A folder with the git mark for a repo, a plain folder otherwise. */
function RepoIcon({ isGit, size }: { isGit: boolean; size: number }) {
  const Icon = isGit ? FolderGit2 : Folder
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
}

/**
 * Decorative 16px radio for the worktree cards: a 1.5px ring at rest that fills
 * to a terracotta dot when picked. The cards carry `aria-checked` already, so
 * this is hidden from the accessibility tree rather than announced twice.
 */
function WorktreeRadio({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 h-4 w-4 shrink-0 rounded-full transition-shadow duration-150 ${
        selected
          ? 'shadow-[inset_0_0_0_5px_var(--color-brand)]'
          : 'shadow-[inset_0_0_0_1.5px_var(--color-outline)]'
      }`}
    />
  )
}

function basename(path: string | null | undefined): string {
  return path?.split('/').filter(Boolean).pop() || ''
}

function stateMessage(context: RepositoryContextResult | null, error: string | null) {
  if (error) return error
  if (!context) return null
  if (context.state === 'not_git_repo') return null
  if (context.state === 'missing_workdir') return 'missing'
  if (context.state === 'error') return context.error || 'error'
  return null
}

export function RepositoryLaunchControls({
  workDir,
  onWorkDirChange,
  branch,
  onBranchChange,
  useWorktree,
  onUseWorktreeChange,
  onLaunchReadyChange,
  disabled = false,
  placement = 'outside',
}: Props) {
  const t = useTranslation()
  const addToast = useUIStore((state) => state.addToast)
  const isMobileBrowser = useMobileViewport() && !isDesktopRuntime()
  const isToolbar = placement === 'toolbar' && !isMobileBrowser
  const [context, setContext] = useState<RepositoryContextResult | null>(null)
  const [contextSourceWorkDir, setContextSourceWorkDir] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [view, setView] = useState<MenuView>('root')
  /**
   * Path just chosen from the directory view, held until its repository
   * context lands. A repo reveals its branch and worktree rows in the root
   * view; anything else has no next step, so the menu closes.
   */
  const [revealAfterPick, setRevealAfterPick] = useState<string | null>(null)
  const [branchFilter, setBranchFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [newBranchName, setNewBranchName] = useState('')
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [createBranchError, setCreateBranchError] = useState<string | null>(null)
  const [projectCreateOpen, setProjectCreateOpen] = useState(false)
  const [projectCreateFolder, setProjectCreateFolder] = useState('')
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; direction: 'up' | 'down' } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** Read after an await to tell whether the directory moved on under us. */
  const latestWorkDirRef = useRef(workDir)
  latestWorkDirRef.current = workDir
  /**
   * Creating a branch updates this component's context and the parent-owned
   * launch target together. An external store can publish the target first,
   * so remember the exact context that makes that new target valid until the
   * local state commit catches up.
   */
  const createdBranchTransitionRef = useRef<{
    workDir: string
    branch: string
    context: RepositoryContextResult
  } | null>(null)
  const searchInputId = useId()
  const listboxId = useId()
  const menuId = useId()
  // The cards show a title and a sentence of description. Pointing the
  // accessible name at the title span keeps the option announced as
  // "Isolated worktree" instead of the whole paragraph (components/AGENTS.md §6).
  const worktreeCurrentLabelId = useId()
  const worktreeIsolatedLabelId = useId()

  const updateMenuPos = useCallback((forView: MenuView) => {
    if (!pillRef.current) return
    const rect = pillRef.current.getBoundingClientRect()
    const height = VIEW_HEIGHTS[forView]
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const direction = spaceBelow >= height || spaceBelow >= spaceAbove ? 'down' : 'up'
    const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER)
    setMenuPos({
      top: direction === 'down' ? rect.bottom + 6 : rect.top - 6,
      left: Math.min(Math.max(rect.left, VIEWPORT_GUTTER), maxLeft),
      direction,
    })
  }, [])

  useEffect(() => {
    if (!workDir) {
      setContext(null)
      setContextSourceWorkDir(null)
      setError(null)
      setLoading(false)
      onBranchChange(null)
      return
    }

    const requestedWorkDir = workDir
    let cancelled = false
    setContextSourceWorkDir(null)
    setLoading(true)
    setError(null)
    sessionsApi.getRepositoryContext(requestedWorkDir)
      .then((result) => {
        if (cancelled) return
        setContext(result)
        setContextSourceWorkDir(requestedWorkDir)
      })
      .catch((err) => {
        if (cancelled) return
        setContext(null)
        setContextSourceWorkDir(null)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [workDir, onBranchChange])

  useEffect(() => {
    createdBranchTransitionRef.current = null
  }, [workDir])

  useEffect(() => {
    if (context?.state !== 'ok') {
      if (context && branch !== null) onBranchChange(null)
      return
    }

    const createdBranchTransition = createdBranchTransitionRef.current
    if (createdBranchTransition?.workDir === workDir) {
      if (context === createdBranchTransition.context) {
        createdBranchTransitionRef.current = null
      } else if (branch === createdBranchTransition.branch) {
        // The parent selection reached us before the refreshed branch list.
        // It is valid against the in-flight create response, so do not replace
        // it with the old context's current branch during this single render.
        return
      }
    }

    const branchExists = branch && context.branches.some((candidate) => candidate.name === branch)
    if (branchExists) return

    const fallbackBranch = [
      context.currentBranch,
      context.defaultBranch,
      context.branches[0]?.name,
    ].find((name) => name && context.branches.some((candidate) => candidate.name === name))

    onBranchChange(fallbackBranch || null)
  }, [branch, context, onBranchChange, workDir])

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setView('root')
    setBranchFilter('')
    setRevealAfterPick(null)
    setNewBranchName('')
    setCreateBranchError(null)
  }, [])

  // The directory list is one of this menu's own views now, so there is no
  // second portalled dropdown to exempt from outside-click handling.
  useDismissable({
    open: menuOpen,
    refs: [rootRef, menuRef],
    onDismiss: closeMenu,
  })

  useEffect(() => {
    if (!menuOpen) return
    const reposition = () => updateMenuPos(view)
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [menuOpen, view, updateMenuPos])

  useEffect(() => {
    if (!menuOpen || view !== 'branch') return
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [menuOpen, view])

  useEffect(() => {
    setSelectedIndex(0)
  }, [branchFilter])

  useEffect(() => {
    const activeItem = menuOpen && view === 'branch' ? itemRefs.current[selectedIndex] : null
    activeItem?.scrollIntoView({ block: 'nearest' })
  }, [menuOpen, view, selectedIndex])

  const selectedBranch = useMemo(() => {
    if (context?.state !== 'ok') return null
    return context.branches.find((candidate) => candidate.name === branch) ?? null
  }, [branch, context])

  const filteredBranches = useMemo(() => {
    if (context?.state !== 'ok') return []
    const query = branchFilter.trim().toLowerCase()
    if (!query) return context.branches
    return context.branches.filter((candidate) => (
      candidate.name.toLowerCase().includes(query) ||
      candidate.remoteRef?.toLowerCase().includes(query) ||
      candidate.worktreePath?.toLowerCase().includes(query)
    ))
  }, [branchFilter, context])

  const warning = useMemo(() => {
    if (context?.state !== 'ok' || !selectedBranch || useWorktree) return null
    // A branch that points where HEAD already points cannot be blocked by
    // uncommitted changes — git only moves the ref, it rewrites nothing. That
    // is exactly the branch you just created off the one you are standing on,
    // so warning about it there is a false alarm. Missing commit info (an older
    // server) keeps the warning rather than dropping it.
    const movesFiles = !(selectedBranch.commit && selectedBranch.commit === context.headCommit)
    if (selectedBranch.name !== context.currentBranch && context.dirty && movesFiles) {
      return {
        message: t('repoLaunch.dirtyWarning'),
        compactLabel: t('repoLaunch.dirtyWarningCompact'),
      }
    }
    if (selectedBranch.name !== context.currentBranch && selectedBranch.checkedOut) {
      return {
        message: t('repoLaunch.checkedOutWarning'),
        compactLabel: t('repoLaunch.checkedOutWarningCompact'),
      }
    }
    return null
  }, [context, selectedBranch, t, useWorktree])

  const selectBranch = (candidate: RepositoryBranchInfo) => {
    onBranchChange(candidate.name)
    setView('root')
    setBranchFilter('')
  }

  const openNewBranchView = () => {
    // Whatever was typed into the filter is almost always the name being looked
    // for, so it seeds the field instead of being thrown away.
    setNewBranchName(branchFilter.trim())
    setCreateBranchError(null)
    setView('newBranch')
  }

  const leaveNewBranchView = () => {
    setNewBranchName('')
    setCreateBranchError(null)
    setView('branch')
  }

  const createBranch = async () => {
    const name = newBranchName.trim()
    if (creatingBranch || context?.state !== 'ok') return
    if (!name) {
      setCreateBranchError(t('repoLaunch.newBranchErrorInvalid'))
      return
    }

    const requestWorkDir = workDir
    setCreatingBranch(true)
    setCreateBranchError(null)
    try {
      const result = await sessionsApi.createRepositoryBranch({
        workDir: requestWorkDir,
        name,
        from: selectedBranch?.name ?? null,
      })
      // Adopting a result for a directory the user has since left would put one
      // repo's branch list and selection under another repo's path — the same
      // reason the `workDir` effect carries a `cancelled` flag.
      if (latestWorkDirRef.current !== requestWorkDir) return
      // The response carries the context the branch was created against, so the
      // list is correct without a second round trip.
      createdBranchTransitionRef.current = {
        workDir: requestWorkDir,
        branch: result.branch,
        context: result.context,
      }
      setContext(result.context)
      setError(null)
      onBranchChange(result.branch)
      addToast({
        type: 'success',
        message: t(
          useWorktree
            ? 'repoLaunch.newBranchSuccessIsolated'
            : 'repoLaunch.newBranchSuccessCurrent',
          { branch: result.branch },
        ),
      })
      // Closing exposes the pill, which now names the branch selected for launch.
      // Keeping the menu open made a successful create look like a no-op.
      closeMenu()
    } catch (err) {
      if (latestWorkDirRef.current !== requestWorkDir) return
      const code = err instanceof Error && 'body' in err
        ? (err as { body?: { error?: string } }).body?.error
        : undefined
      const known = code && code in BRANCH_CREATE_ERROR_KEYS
        ? BRANCH_CREATE_ERROR_KEYS[code as keyof typeof BRANCH_CREATE_ERROR_KEYS]
        : null
      // The server's own message already reads "Failed to create branch: …", so
      // prefixing the generic line onto it says the same thing twice. The
      // generic line is for failures that arrive without one, e.g. a timeout.
      const raw = err instanceof Error ? err.message.trim() : String(err).trim()
      setCreateBranchError(known ? t(known) : raw || t('repoLaunch.newBranchErrorFailed'))
    } finally {
      // Unconditional: a stale response must still clear the spinner, or the
      // form stays disabled for the directory the user moved to.
      setCreatingBranch(false)
    }
  }

  const selectWorktreeMode = (enabled: boolean) => {
    onUseWorktreeChange(enabled)
    closeMenu()
  }

  const handleWorkDirChange = (path: string) => {
    onWorkDirChange(path)
    if (path === workDir) {
      // Re-picking the current directory fires no context request, so there is
      // nothing to wait for.
      if (isGitReady) setView('root')
      else closeMenu()
      return
    }
    // Hold the menu open on the root view. If the new directory turns out to
    // be a repo, its branch and worktree rows appear right where the eye
    // already is; if it does not, `revealAfterPick` closes the menu instead.
    setRevealAfterPick(path)
    setView('root')
  }

  // The editor modal lives here, not in the panel: the menu (and with it the
  // panel) unmounts once it closes. Submitting names the project and makes its
  // folder the launch directory; the session is still only created on send.
  const handleProjectCreateOpen = () => {
    closeMenu()
    setProjectCreateFolder('')
    setProjectCreateOpen(true)
  }

  const handleProjectCreateSubmit = async (submission: ProjectEditorSubmission) => {
    await setProjectDisplayName(submission.sourceFolder, submission.name)
    invalidateRecentProjectsCache()
    setProjectCreateOpen(false)
    onWorkDirChange(submission.sourceFolder)
  }

  const handleBranchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, Math.max(filteredBranches.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const candidate = filteredBranches[selectedIndex]
      if (candidate) selectBranch(candidate)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setView('root')
    }
  }

  const message = stateMessage(context, error)
  const isGitReady = context?.state === 'ok'
  const isLaunchReady = !workDir || (
    !loading &&
    (!!context || !!error) &&
    (
      context?.state !== 'ok' ||
      context.branches.length === 0 ||
      !!selectedBranch
    )
  )

  useEffect(() => {
    onLaunchReadyChange?.(isLaunchReady)
  }, [isLaunchReady, onLaunchReadyChange])

  // Resolve a pending directory pick once its own context lands. The identity
  // check matters: on the render right after the pick, `context` still
  // describes the *previous* directory and `loading` has not flipped yet, so
  // reading either one unguarded decides on the wrong repo.
  useEffect(() => {
    if (!revealAfterPick || loading) return
    const settled = contextSourceWorkDir === revealAfterPick
      || (!!error && workDir === revealAfterPick)
    if (!settled) return
    setRevealAfterPick(null)
    if (context?.state !== 'ok') closeMenu()
  }, [revealAfterPick, loading, context, contextSourceWorkDir, error, workDir, closeMenu])

  const projectKey = contextSourceWorkDir === workDir && context
    ? (context.repoRoot || context.workDir)
    : workDir
  const displayName = useProjectDisplayName(projectKey)
  const repoLabel = displayName || context?.repoName || basename(context?.repoRoot) || basename(workDir)
  const selectedBranchName = isGitReady ? (selectedBranch?.name ?? null) : null
  // The worktree cards name the branch their changes would land on.
  const branchLabel = selectedBranch?.name ?? context?.currentBranch ?? t('repoLaunch.noBranch')
  const worktreeLabel = useWorktree ? t('repoLaunch.worktreeIsolated') : t('repoLaunch.worktreeCurrent')
  const summary = [repoLabel, selectedBranchName].filter(Boolean).join(' / ')
  const pillTitle = [
    workDir,
    selectedBranchName ? `${t('repoLaunch.branch')}: ${selectedBranchName}` : null,
    useWorktree ? worktreeLabel : null,
  ].filter(Boolean).join('\n')

  const branchSubtitle = selectedBranch
    ? (selectedBranch.current
        ? t('repoLaunch.currentBranch')
        : selectedBranch.checkedOut
          ? t('repoLaunch.checkedOut')
          : selectedBranch.remote && !selectedBranch.local
            ? selectedBranch.remoteRef || t('repoLaunch.remoteBranch')
            : t('repoLaunch.localBranch'))
    : t('repoLaunch.noBranch')

  // A quiet toolbar chip, not an outlined pill: the composer toolbar reads
  // `folder project / branch` in tertiary text and only fills on hover, the
  // same as the permission chip and model name beside it. The focus ring uses
  // the opaque focus token rather than `--color-brand/35`, whose `/N` modifier
  // Safari 15 drops.
  const pillClassName = [
    'group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5',
    'text-xs leading-none text-[var(--color-text-tertiary)]',
    'transition-[background-color,color] duration-150 ease-out',
    'hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]',
    'disabled:cursor-not-allowed disabled:opacity-50',
    // 28px in the toolbar, matching its other controls; on its own line below
    // the composer the H5 layout needs a 40px touch target.
    isToolbar || !isMobileBrowser ? 'h-7' : 'h-10',
  ].join(' ')

  const rowClassName = [
    'flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 text-left',
    'transition-[background-color] duration-150 ease-out',
    'hover:bg-[var(--color-surface-hover)]',
    'focus-visible:outline-none focus-visible:bg-[var(--color-surface-hover)]',
    isMobileBrowser ? 'min-h-[56px] py-3' : 'min-h-8 py-1.5',
  ].join(' ')

  // Both drill-downs head back the same way. The dropdown labels the crumb
  // after the view you are in; the sheet, which has its own title bar, labels
  // it after the view you are going to.
  const dropdownBackClassName = 'inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'
  const sheetBackClassName = 'inline-flex items-center gap-1 self-start rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]'

  // The two modes are a single choice, so they read as radio cards rather than
  // a menu list: a hairline at rest, a 1.5px terracotta edge on a faint
  // terracotta wash once picked. Inset shadows rather than borders so the edge
  // can thicken without nudging the content.
  const worktreeCardClassName = (selected: boolean) => [
    'flex w-full items-start gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-left',
    'transition-[background-color,box-shadow] duration-150 ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
    selected
      ? 'bg-[var(--color-brand-soft)] shadow-[inset_0_0_0_1.5px_var(--color-brand)]'
      : 'bg-[var(--color-surface-container-lowest)] shadow-[inset_0_0_0_1px_var(--color-border)] hover:shadow-[inset_0_0_0_1px_var(--color-outline)]',
  ].join(' ')

  const branchList = (
    <div
      id={listboxId}
      role="listbox"
      aria-label={t('repoLaunch.selectBranch')}
      className={isMobileBrowser ? 'p-1.5' : 'max-h-[280px] overflow-y-auto'}
    >
      {filteredBranches.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-[var(--color-text-tertiary)]">
          {t('repoLaunch.noBranchMatch')}
        </div>
      ) : filteredBranches.map((candidate, index) => {
        const isSelected = candidate.name === selectedBranch?.name
        return (
          <button
            key={candidate.name}
            id={`${listboxId}-option-${index}`}
            ref={(el) => { itemRefs.current[index] = el }}
            type="button"
            role="option"
            aria-selected={isSelected}
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => selectBranch(candidate)}
            className={`flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 text-left transition-[background-color] duration-150 ease-out focus-visible:outline-none focus-visible:bg-[var(--color-surface-hover)] ${
              isMobileBrowser ? 'min-h-[56px] py-3' : 'min-h-8 py-1.5'
            } ${
              index === selectedIndex || isSelected ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'
            }`}
          >
            <GitBranch size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[13px] text-[var(--color-text-primary)]">
                {candidate.name}
              </span>
              <span className="block truncate text-xs text-[var(--color-text-tertiary)]">
                {candidate.current
                  ? t('repoLaunch.currentBranch')
                  : candidate.checkedOut
                    ? t('repoLaunch.checkedOut')
                    : candidate.remote && !candidate.local
                      ? candidate.remoteRef || t('repoLaunch.remoteBranch')
                      : t('repoLaunch.localBranch')}
              </span>
            </span>
            {isSelected && <Check size={14} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--color-brand)]" />}
          </button>
        )
      })}
    </div>
  )

  /**
   * Sits under the list, never inside it: the list is a `role="listbox"`, and an
   * action button among its `option`s would be read as a branch you could pick
   * (components/AGENTS.md §6).
   *
   * The separator is the host's job, because the two hosts pin this differently
   * — the dropdown puts it after `branchList`'s own `overflow-y-auto` box, the
   * sheet hands it to `MobileBottomSheet`'s `footer` slot, which is `shrink-0`
   * outside the scrolling body and brings its own top border. Rendering it as a
   * sibling in the sheet's `children` instead would let it scroll away with the
   * list, which is the one thing it must not do.
   */
  const branchCreateRow = (
    <button
      type="button"
      onClick={openNewBranchView}
      className={rowClassName}
    >
      <Plus size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-primary)]">
        {t('repoLaunch.newBranch')}
      </span>
    </button>
  )

  const newBranchForm = (
    <form
      className="flex flex-col gap-3 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        void createBranch()
      }}
    >
      <Input
        label={t('repoLaunch.newBranchNameLabel')}
        placeholder={t('repoLaunch.newBranchPlaceholder')}
        value={newBranchName}
        onChange={(event) => {
          setNewBranchName(event.target.value)
          setCreateBranchError(null)
        }}
        error={createBranchError ?? undefined}
        hint={t('repoLaunch.newBranchFrom', { branch: branchLabel })}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        disabled={creatingBranch}
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="base" onClick={leaveNewBranchView}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="base"
          loading={creatingBranch}
        >
          {t('repoLaunch.newBranchSubmit')}
        </Button>
      </div>
    </form>
  )

  // The menu-search row: a bare field on the menu, set off by the hairline its
  // host draws under it — not a boxed input inside a box.
  const branchSearch = (
    <div className="flex h-8 items-center gap-2 px-2">
      <Search size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
      <input
        id={searchInputId}
        ref={searchRef}
        value={branchFilter}
        onChange={(event) => setBranchFilter(event.target.value)}
        onKeyDown={handleBranchKeyDown}
        aria-controls={listboxId}
        aria-activedescendant={filteredBranches[selectedIndex] ? `${listboxId}-option-${selectedIndex}` : undefined}
        placeholder={t('repoLaunch.searchBranch')}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
      />
    </div>
  )

  // Stands in for the branch row and the two worktree cards while the picked
  // directory is being inspected, so the menu does not jump a couple hundred
  // pixels taller the moment the context lands.
  const revealSkeleton = (
    <div aria-hidden="true" className="flex animate-pulse flex-col gap-1">
      <div className="h-11 rounded-[var(--radius-sm)] bg-[var(--color-surface-container)]" />
      <div className="mx-1 my-1 h-px bg-[var(--color-border-separator)]" />
      <div className="h-16 rounded-[var(--radius-md)] bg-[var(--color-surface-container)]" />
      <div className="h-16 rounded-[var(--radius-md)] bg-[var(--color-surface-container)]" />
    </div>
  )

  const rootView = (
    <div role="menu" aria-label={t('repoLaunch.launchLocation')} className={`flex flex-col gap-0.5 ${isMobileBrowser ? 'p-1.5' : ''}`}>
      <button
        type="button"
        role="menuitem"
        onClick={() => setView('directory')}
        title={workDir || undefined}
        className={rowClassName}
      >
        <RepoIcon isGit={isGitReady} size={16} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-[var(--color-text-primary)]">
            {t('dirPicker.directory')}
          </span>
          <span className="block truncate text-xs text-[var(--color-text-tertiary)]">
            {workDir ? repoLabel : t('dirPicker.selectProject')}
          </span>
        </span>
        <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
      </button>

      {revealAfterPick && revealSkeleton}

      {isGitReady && (
        <button
          type="button"
          role="menuitem"
          onClick={() => setView('branch')}
          className={rowClassName}
        >
          <GitBranch size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-[var(--color-text-primary)]">
              {t('repoLaunch.branch')}
            </span>
            <span className="block truncate text-xs text-[var(--color-text-tertiary)]">
              {selectedBranchName ? `${selectedBranchName} · ${branchSubtitle}` : t('repoLaunch.noBranch')}
            </span>
          </span>
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        </button>
      )}

      {isGitReady && (
        <>
          <div className="mx-1 my-1 h-px bg-[var(--color-border-separator)]" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!useWorktree}
            aria-labelledby={worktreeCurrentLabelId}
            onClick={() => selectWorktreeMode(false)}
            className={worktreeCardClassName(!useWorktree)}
          >
            <WorktreeRadio selected={!useWorktree} />
            <span className="min-w-0 flex-1">
              <span id={worktreeCurrentLabelId} className="block text-[13px] font-medium text-[var(--color-text-primary)]">
                {t('repoLaunch.worktreeCurrent')}
              </span>
              <span className="mt-0.5 block text-xs leading-[1.55] text-[var(--color-text-tertiary)]">
                {t('repoLaunch.worktreeCurrentDesc', { branch: branchLabel })}
              </span>
            </span>
          </button>

          <button
            type="button"
            role="menuitemradio"
            aria-checked={useWorktree}
            aria-labelledby={worktreeIsolatedLabelId}
            onClick={() => selectWorktreeMode(true)}
            className={worktreeCardClassName(useWorktree)}
          >
            <WorktreeRadio selected={useWorktree} />
            <span className="min-w-0 flex-1">
              <span id={worktreeIsolatedLabelId} className="block text-[13px] font-medium text-[var(--color-text-primary)]">
                {t('repoLaunch.worktreeIsolated')}
              </span>
              <span className="mt-0.5 block text-xs leading-[1.55] text-[var(--color-text-tertiary)]">
                {t('repoLaunch.worktreeIsolatedDesc', { branch: branchLabel })}
              </span>
            </span>
          </button>
        </>
      )}
    </div>
  )

  const directoryList = (
    <RecentProjectsPanel
      value={workDir}
      onSelect={handleWorkDirChange}
      touch={isMobileBrowser}
      showRecentHeading={!isMobileBrowser}
      onCreateProject={handleProjectCreateOpen}
    />
  )

  /**
   * Only offered once there is a repo behind the pill. Without one the root
   * view is a single directory row, so going "back" to it would land on the
   * empty shell this view exists to skip.
   */
  const directoryBackLabel = isGitReady ? t('dirPicker.directory') : null

  const pill = (
    <button
      ref={pillRef}
      type="button"
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? menuId : undefined}
      aria-label={`${t('repoLaunch.launchLocation')}: ${summary || t('dirPicker.selectProject')}`}
      title={pillTitle}
      onClick={() => {
        const opening = !menuOpen
        setMenuOpen(opening)
        setBranchFilter('')
        setRevealAfterPick(null)
        // Open on the view that has something in it. With no repo context
        // there is no branch row and no worktree cards, so the root view would
        // be a lone "Directory" line — one click spent on nothing.
        if (opening) setView(isGitReady ? 'root' : 'directory')
      }}
      className={pillClassName}
    >
      <Folder size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />

      <span className="min-w-[1.75rem] shrink truncate">
        {repoLabel || t('dirPicker.selectProject')}
      </span>

      {selectedBranchName && (
        <>
          <span aria-hidden="true" className="shrink-0 text-[var(--color-outline)]">/</span>
          <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          {/*
            `dir="rtl"` puts the ellipsis at the *start*, so a truncated branch
            keeps its tail: `…use-native-on-main` rather than `feature/comp…`.
            The distinguishing part of a branch name is the end — `feature/`
            prefixes carry no information. `<bdi>` isolates the name so the RTL
            container cannot reorder its own neutral characters (the slashes).
          */}
          <span dir="rtl" className="min-w-0 shrink truncate text-left">
            <bdi>{selectedBranchName}</bdi>
          </span>
        </>
      )}

      {useWorktree && isGitReady && (
        <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--color-surface-container)] px-1.5 text-[11px] font-medium leading-none text-[var(--color-text-secondary)]">
          <GitFork size={12} strokeWidth={2} aria-hidden="true" />
          {t('repoLaunch.worktreeBadge')}
        </span>
      )}

      {loading && workDir
        ? <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin text-[var(--color-text-tertiary)]" />
        : <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />}
    </button>
  )

  const menuClassName = 'w-[400px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-dropdown)]'
  const menuStyle = {
    position: 'fixed' as const,
    left: menuPos?.left,
    ...(menuPos?.direction === 'down'
      ? { top: menuPos.top }
      : { bottom: window.innerHeight - (menuPos?.top ?? 0) }),
    zIndex: 'var(--z-dropdown)',
  }

  return (
    <div
      ref={rootRef}
      // `shrink` in the toolbar: a long branch name must cost the pill its own
      // width, never the width of "+" or the permission selector beside it.
      className={`flex min-w-0 flex-col ${isToolbar ? 'shrink gap-0' : 'gap-1.5'}`}
    >
      {isToolbar ? (
        <div className="flex min-w-0 flex-row items-center gap-2">
          {pill}
          {warning && (
            <div
              role="status"
              aria-label={warning.message}
              title={warning.message}
              className="inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--color-warning-container)] px-1.5 text-[11px] font-medium text-[var(--color-on-warning-container)]"
            >
              <AlertCircle size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
              <span className="hidden 2xl:inline">{warning.compactLabel}</span>
            </div>
          )}
        </div>
      ) : pill}

      {message && workDir && (
        <div className="flex items-center gap-1.5 px-1.5 text-xs text-[var(--color-text-tertiary)]">
          <AlertCircle size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          <span>{message === 'missing' ? t('repoLaunch.missingWorkdir') : message}</span>
        </div>
      )}

      {warning && !isToolbar && (
        <div
          role="status"
          aria-label={warning.message}
          className="flex items-center gap-1.5 px-1.5 text-xs text-[var(--color-on-warning-container)]"
        >
          <AlertCircle size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--color-warning)]" />
          <span>{warning.message}</span>
        </div>
      )}

      {menuOpen && (
        isMobileBrowser ? (
          <MobileBottomSheet
            open={menuOpen}
            onClose={closeMenu}
            title={
              view === 'branch'
                ? t('repoLaunch.selectBranch')
                : view === 'newBranch'
                  ? t('repoLaunch.newBranchTitle')
                  : view === 'directory'
                    ? t('dirPicker.directory')
                    : t('repoLaunch.launchLocation')
            }
            closeLabel={t('tabs.close')}
            panelRef={menuRef}
            id={menuId}
            footer={view === 'branch' ? <div className="p-1.5">{branchCreateRow}</div> : undefined}
            headerExtra={view === 'branch' ? (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setView('root')}
                  className={sheetBackClassName}
                >
                  <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                  {t('repoLaunch.launchLocation')}
                </button>
                {branchSearch}
              </div>
            ) : view === 'newBranch' ? (
              <button
                type="button"
                onClick={leaveNewBranchView}
                className={sheetBackClassName}
              >
                <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                {t('repoLaunch.selectBranch')}
              </button>
            ) : view === 'directory' && directoryBackLabel ? (
              <button
                type="button"
                onClick={() => setView('root')}
                className={sheetBackClassName}
              >
                <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                {t('repoLaunch.launchLocation')}
              </button>
            ) : undefined}
          >
            {view === 'branch'
              ? branchList
              : view === 'newBranch'
                ? newBranchForm
                : view === 'directory' ? directoryList : rootView}
          </MobileBottomSheet>
        ) : menuPos && createPortal(
          <div ref={menuRef} id={menuId} className={menuClassName} style={menuStyle}>
            {view === 'branch' ? (
              <>
                <div className="mb-1 border-b border-[var(--color-border)]">
                  <button
                    type="button"
                    onClick={() => setView('root')}
                    className={dropdownBackClassName}
                  >
                    <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                    {t('repoLaunch.selectBranch')}
                  </button>
                  {branchSearch}
                </div>
                {branchList}
                <div className="mt-1 border-t border-[var(--color-border-separator)] pt-1">
                  {branchCreateRow}
                </div>
              </>
            ) : view === 'newBranch' ? (
              <>
                <div className="border-b border-[var(--color-border)] pb-1">
                  <button
                    type="button"
                    onClick={leaveNewBranchView}
                    className={dropdownBackClassName}
                  >
                    <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                    {t('repoLaunch.newBranchTitle')}
                  </button>
                </div>
                {newBranchForm}
              </>
            ) : view === 'directory' ? (
              <>
                {directoryBackLabel && (
                  <div className="border-b border-[var(--color-border)] pb-1">
                    <button
                      type="button"
                      onClick={() => setView('root')}
                      className={dropdownBackClassName}
                    >
                      <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                      {directoryBackLabel}
                    </button>
                  </div>
                )}
                {directoryList}
              </>
            ) : (
              <>
                <div className="px-2 pb-1 pt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                  {t('repoLaunch.launchLocation')}
                </div>
                {rootView}
              </>
            )}
          </div>,
          document.body,
        )
      )}

      <ProjectEditorModal
        open={projectCreateOpen}
        mode="create"
        sourceFolder={projectCreateFolder}
        onSourceFolderChange={setProjectCreateFolder}
        onClose={() => setProjectCreateOpen(false)}
        onSubmit={handleProjectCreateSubmit}
      />
    </div>
  )
}
