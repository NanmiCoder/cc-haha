import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import { RecentProjectsPanel } from '@/components/composite/DirectoryPicker'
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
 * branch list and returns to it.
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

const GIT_MARK_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z'

/**
 * Git mark for a repo, plain folder otherwise. The folder glyph reads smaller
 * than the mark at the same nominal size, hence the separate `folderSize`.
 */
function RepoIcon({ isGit, size, folderSize = size }: { isGit: boolean; size: number; folderSize?: number }) {
  if (isGit) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]">
        <path d={GIT_MARK_PATH} />
      </svg>
    )
  }
  return (
    <span
      aria-hidden="true"
      className="material-symbols-outlined shrink-0 text-[var(--color-text-tertiary)]"
      style={{ fontSize: folderSize }}
    >
      folder
    </span>
  )
}

/**
 * Decorative dot for the worktree cards. The cards carry `aria-checked`
 * already, so this is hidden from the accessibility tree rather than announced
 * a second time.
 */
function WorktreeRadio({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-[var(--color-outline)]"
    >
      {selected && <span className="h-[9px] w-[9px] rounded-full bg-[var(--color-brand)]" />}
    </span>
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
  const isMobileBrowser = useMobileViewport() && !isDesktopRuntime()
  const isToolbar = placement === 'toolbar' && !isMobileBrowser
  const [context, setContext] = useState<RepositoryContextResult | null>(null)
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
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; direction: 'up' | 'down' } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** Read after an await to tell whether the directory moved on under us. */
  const latestWorkDirRef = useRef(workDir)
  latestWorkDirRef.current = workDir
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
      setError(null)
      setLoading(false)
      onBranchChange(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    sessionsApi.getRepositoryContext(workDir)
      .then((result) => {
        if (cancelled) return
        setContext(result)
      })
      .catch((err) => {
        if (cancelled) return
        setContext(null)
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
    if (context?.state !== 'ok') {
      if (context && branch !== null) onBranchChange(null)
      return
    }

    const branchExists = branch && context.branches.some((candidate) => candidate.name === branch)
    if (branchExists) return

    const fallbackBranch = [
      context.currentBranch,
      context.defaultBranch,
      context.branches[0]?.name,
    ].find((name) => name && context.branches.some((candidate) => candidate.name === name))

    onBranchChange(fallbackBranch || null)
  }, [branch, context, onBranchChange])

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
    if (!name || creatingBranch || context?.state !== 'ok') return

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
      setContext(result.context)
      setError(null)
      onBranchChange(result.branch)
      setNewBranchName('')
      setBranchFilter('')
      setView('root')
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
    const settled = context?.workDir === revealAfterPick
      || (!!error && workDir === revealAfterPick)
    if (!settled) return
    setRevealAfterPick(null)
    if (context?.state !== 'ok') closeMenu()
  }, [revealAfterPick, loading, context, error, workDir, closeMenu])

  const repoLabel = context?.repoName || basename(context?.repoRoot) || basename(workDir)
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

  // Outlined pill, per the handoff's launch row: 1px border at rest that firms
  // up to `--color-outline` on hover. The focus ring uses the opaque focus
  // token rather than `--color-brand/35`, whose `/N` modifier Safari 15 drops.
  const pillClassName = [
    'group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-lg)]',
    'border border-[var(--color-border)] bg-[var(--color-surface)] font-medium leading-none',
    'text-[var(--color-text-primary)] transition-[background-color,color,border-color] duration-150 ease-out',
    'hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]',
    'disabled:cursor-not-allowed disabled:opacity-50',
    isToolbar ? 'h-9 px-3 text-[13.5px]' : 'h-10 px-3.5 text-[13.5px]',
  ].join(' ')

  const rowClassName = [
    'flex w-full items-center gap-3 rounded-[var(--radius-lg)] px-3 text-left',
    'transition-[background-color,border-color] duration-150 ease-out',
    'hover:bg-[var(--color-surface-hover)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]',
    isMobileBrowser ? 'min-h-[56px] py-3' : 'py-2.5',
  ].join(' ')

  // Both drill-downs head back the same way. The dropdown labels the crumb
  // after the view you are in; the sheet, which has its own title bar, labels
  // it after the view you are going to.
  const dropdownBackClassName = 'inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)] transition-colors hover:text-[var(--color-text-secondary)]'
  const sheetBackClassName = 'inline-flex items-center gap-1 self-start rounded-[var(--radius-md)] px-2 py-1 text-[12px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]'

  // The two modes are a single choice, so they read as radio cards rather than
  // a menu list: 1.5px edge that turns terracotta on the selected one.
  const worktreeCardClassName = (selected: boolean) => [
    'flex w-full items-start gap-3 rounded-[var(--radius-lg)] border-[1.5px] px-[15px] py-3 text-left',
    'transition-[background-color,border-color] duration-150 ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]',
    selected
      ? 'border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)]'
      : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)]',
  ].join(' ')

  const branchList = (
    <div
      id={listboxId}
      role="listbox"
      aria-label={t('repoLaunch.selectBranch')}
      className={isMobileBrowser ? 'py-1' : 'max-h-[280px] overflow-y-auto py-1'}
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
            className={`flex w-full items-center gap-3 px-4 text-left transition-[background-color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] ${
              isMobileBrowser ? 'min-h-[56px] py-3' : 'py-3'
            } ${
              index === selectedIndex || isSelected ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'
            }`}
          >
            <span className={`h-8 w-1 rounded-full ${isSelected ? 'bg-[var(--color-brand)]' : 'bg-transparent'}`} />
            <GitBranch size={17} className="shrink-0 text-[var(--color-text-secondary)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[var(--color-text-primary)]">
                {candidate.name}
              </span>
              <span className="block truncate text-[11px] text-[var(--color-text-tertiary)]">
                {candidate.current
                  ? t('repoLaunch.currentBranch')
                  : candidate.checkedOut
                    ? t('repoLaunch.checkedOut')
                    : candidate.remote && !candidate.local
                      ? candidate.remoteRef || t('repoLaunch.remoteBranch')
                      : t('repoLaunch.localBranch')}
              </span>
            </span>
            {isSelected && <Check size={17} className="shrink-0 text-[var(--color-brand)]" />}
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
      <Plus size={17} className="shrink-0 text-[var(--color-text-tertiary)]" />
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[var(--color-text-primary)]">
        {t('repoLaunch.newBranch')}
      </span>
    </button>
  )

  const newBranchForm = (
    <form
      className="flex flex-col gap-3 p-3"
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
          disabled={!newBranchName.trim()}
        >
          {t('repoLaunch.newBranchSubmit')}
        </Button>
      </div>
    </form>
  )

  const branchSearch = (
    <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2">
      <Search size={15} className="shrink-0 text-[var(--color-text-tertiary)]" />
      <input
        id={searchInputId}
        ref={searchRef}
        value={branchFilter}
        onChange={(event) => setBranchFilter(event.target.value)}
        onKeyDown={handleBranchKeyDown}
        aria-controls={listboxId}
        aria-activedescendant={filteredBranches[selectedIndex] ? `${listboxId}-option-${selectedIndex}` : undefined}
        placeholder={t('repoLaunch.searchBranch')}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
      />
    </div>
  )

  // Stands in for the branch row and the two worktree cards while the picked
  // directory is being inspected, so the menu does not jump a couple hundred
  // pixels taller the moment the context lands.
  const revealSkeleton = (
    <div aria-hidden="true" className="flex animate-pulse flex-col gap-1">
      <div className="h-[52px] rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)]" />
      <div className="mx-1.5 my-1 h-px bg-[var(--color-border-separator)]" />
      <div className="h-[74px] rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)]" />
      <div className="h-[74px] rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)]" />
    </div>
  )

  const rootView = (
    <div role="menu" aria-label={t('repoLaunch.launchLocation')} className="flex flex-col gap-1 p-1.5">
      <button
        type="button"
        role="menuitem"
        onClick={() => setView('directory')}
        title={workDir || undefined}
        className={rowClassName}
      >
        <RepoIcon isGit={isGitReady} size={18} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-[var(--color-text-primary)]">
            {t('dirPicker.directory')}
          </span>
          <span className="block truncate text-[11px] text-[var(--color-text-tertiary)]">
            {workDir ? repoLabel : t('dirPicker.selectProject')}
          </span>
        </span>
        <ChevronRight size={16} className="shrink-0 text-[var(--color-text-tertiary)]" />
      </button>

      {revealAfterPick && revealSkeleton}

      {isGitReady && (
        <button
          type="button"
          role="menuitem"
          onClick={() => setView('branch')}
          className={rowClassName}
        >
          <GitBranch size={18} className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold text-[var(--color-text-primary)]">
              {t('repoLaunch.branch')}
            </span>
            <span className="block truncate text-[12px] text-[var(--color-text-tertiary)]">
              {selectedBranchName ? `${selectedBranchName} · ${branchSubtitle}` : t('repoLaunch.noBranch')}
            </span>
          </span>
          <ChevronRight size={16} className="shrink-0 text-[var(--color-text-tertiary)]" />
        </button>
      )}

      {isGitReady && (
        <>
          <div className="mx-1.5 my-1 h-px bg-[var(--color-border-separator)]" />
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
              <span id={worktreeCurrentLabelId} className="block text-[14.5px] font-bold text-[var(--color-text-primary)]">
                {t('repoLaunch.worktreeCurrent')}
              </span>
              <span className="mt-[3px] block text-[12.5px] leading-[1.6] text-[var(--color-text-secondary)]">
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
              <span id={worktreeIsolatedLabelId} className="block text-[14.5px] font-bold text-[var(--color-text-primary)]">
                {t('repoLaunch.worktreeIsolated')}
              </span>
              <span className="mt-[3px] block text-[12.5px] leading-[1.6] text-[var(--color-text-secondary)]">
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
      <RepoIcon isGit={isGitReady} size={15} folderSize={17} />

      <span className="min-w-[1.75rem] shrink truncate">
        {repoLabel || t('dirPicker.selectProject')}
      </span>

      {selectedBranchName && (
        <>
          <span aria-hidden="true" className="shrink-0 text-[var(--color-outline-variant)]">/</span>
          {/*
            `dir="rtl"` puts the ellipsis at the *start*, so a truncated branch
            keeps its tail: `…use-native-on-main` rather than `feature/comp…`.
            The distinguishing part of a branch name is the end — `feature/`
            prefixes carry no information. `<bdi>` isolates the name so the RTL
            container cannot reorder its own neutral characters (the slashes).
          */}
          <span dir="rtl" className="min-w-0 shrink truncate text-left text-[var(--color-text-secondary)]">
            <bdi>{selectedBranchName}</bdi>
          </span>
        </>
      )}

      {useWorktree && isGitReady && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-brand-soft)] px-1.5 py-1 text-[10px] font-bold leading-none text-[var(--color-brand)]">
          <GitFork size={11} aria-hidden="true" />
          {t('repoLaunch.worktreeBadge')}
        </span>
      )}

      {loading && workDir
        ? <Loader2 size={15} className="shrink-0 animate-spin text-[var(--color-text-tertiary)]" />
        : <ChevronDown size={15} className="shrink-0 text-[var(--color-text-tertiary)]" />}
    </button>
  )

  const menuClassName = 'w-[400px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-overlay)]'
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
              className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-2 text-[11px] font-medium text-[var(--color-on-warning-container)]"
            >
              <AlertCircle size={13} aria-hidden="true" className="shrink-0 text-[var(--color-warning)]" />
              <span className="hidden 2xl:inline">{warning.compactLabel}</span>
            </div>
          )}
        </div>
      ) : pill}

      {message && workDir && (
        <div className="flex items-center gap-2 px-1 text-[11px] text-[var(--color-text-tertiary)]">
          <AlertCircle size={13} className="shrink-0" />
          <span>{message === 'missing' ? t('repoLaunch.missingWorkdir') : message}</span>
        </div>
      )}

      {warning && !isToolbar && (
        <div
          role="status"
          aria-label={warning.message}
          className="flex items-center gap-2 px-1 text-[11px] text-[var(--color-warning)]"
        >
          <AlertCircle size={13} aria-hidden="true" className="shrink-0" />
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
                  <ChevronLeft size={14} />
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
                <ChevronLeft size={14} />
                {t('repoLaunch.selectBranch')}
              </button>
            ) : view === 'directory' && directoryBackLabel ? (
              <button
                type="button"
                onClick={() => setView('root')}
                className={sheetBackClassName}
              >
                <ChevronLeft size={14} />
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
                <div className="border-b border-[var(--color-border)] p-3">
                  <button
                    type="button"
                    onClick={() => setView('root')}
                    className={`mb-2 ${dropdownBackClassName}`}
                  >
                    <ChevronLeft size={13} />
                    {t('repoLaunch.selectBranch')}
                  </button>
                  {branchSearch}
                </div>
                {branchList}
                <div className="border-t border-[var(--color-border-separator)] p-1.5">
                  {branchCreateRow}
                </div>
              </>
            ) : view === 'newBranch' ? (
              <>
                <div className="border-b border-[var(--color-border)] px-3 py-2.5">
                  <button
                    type="button"
                    onClick={leaveNewBranchView}
                    className={dropdownBackClassName}
                  >
                    <ChevronLeft size={13} />
                    {t('repoLaunch.newBranchTitle')}
                  </button>
                </div>
                {newBranchForm}
              </>
            ) : view === 'directory' ? (
              <>
                {directoryBackLabel && (
                  <div className="border-b border-[var(--color-border)] px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => setView('root')}
                      className={dropdownBackClassName}
                    >
                      <ChevronLeft size={13} />
                      {directoryBackLabel}
                    </button>
                  </div>
                )}
                {directoryList}
              </>
            ) : (
              <>
                <div className="px-4 pb-1 pt-3 text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
                  {t('repoLaunch.launchLocation')}
                </div>
                {rootView}
              </>
            )}
          </div>,
          document.body,
        )
      )}
    </div>
  )
}
