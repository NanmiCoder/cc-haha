import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Check,
  ChevronDown,
  GitBranch,
  GitFork,
  Loader2,
  Search,
} from 'lucide-react'
import {
  sessionsApi,
  type RepositoryBranchInfo,
  type RepositoryContextResult,
} from '../../api/sessions'
import { useTranslation } from '../../i18n'
import { DirectoryPicker } from './DirectoryPicker'

type Props = {
  workDir: string
  onWorkDirChange: (path: string) => void
  branch: string | null
  onBranchChange: (branch: string | null) => void
  useWorktree: boolean
  onUseWorktreeChange: (enabled: boolean) => void
  onLaunchReadyChange?: (ready: boolean) => void
  disabled?: boolean
}

const BRANCH_MENU_HEIGHT = 360
const BRANCH_MENU_WIDTH = 390
const WORKTREE_MENU_HEIGHT = 126
const WORKTREE_MENU_WIDTH = 226
const VIEWPORT_GUTTER = 12

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
}: Props) {
  const t = useTranslation()
  const [context, setContext] = useState<RepositoryContextResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [branchFilter, setBranchFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; direction: 'up' | 'down' } | null>(null)
  const [worktreeMenuOpen, setWorktreeMenuOpen] = useState(false)
  const [worktreeMenuPos, setWorktreeMenuPos] = useState<{ top: number; left: number; direction: 'up' | 'down' } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const branchButtonRef = useRef<HTMLButtonElement>(null)
  const worktreeButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const worktreeMenuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const searchInputId = useId()
  const listboxId = useId()
  const worktreeListboxId = useId()

  const updateMenuPos = useCallback(() => {
    if (!branchButtonRef.current) return
    const rect = branchButtonRef.current.getBoundingClientRect()
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const direction = spaceBelow >= BRANCH_MENU_HEIGHT || spaceBelow >= spaceAbove ? 'down' : 'up'
    const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - BRANCH_MENU_WIDTH - VIEWPORT_GUTTER)
    setMenuPos({
      top: direction === 'down' ? rect.bottom + 6 : rect.top - 6,
      left: Math.min(Math.max(rect.left, VIEWPORT_GUTTER), maxLeft),
      direction,
    })
  }, [])

  const updateWorktreeMenuPos = useCallback(() => {
    if (!worktreeButtonRef.current) return
    const rect = worktreeButtonRef.current.getBoundingClientRect()
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const direction = spaceBelow >= WORKTREE_MENU_HEIGHT || spaceBelow >= spaceAbove ? 'down' : 'up'
    const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - WORKTREE_MENU_WIDTH - VIEWPORT_GUTTER)
    setWorktreeMenuPos({
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

  useEffect(() => {
    if (!branchMenuOpen && !worktreeMenuOpen) return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      if (worktreeMenuRef.current?.contains(target)) return
      setBranchMenuOpen(false)
      setWorktreeMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setBranchMenuOpen(false)
      setWorktreeMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [branchMenuOpen, worktreeMenuOpen])

  useEffect(() => {
    if (!branchMenuOpen) return
    updateMenuPos()
    window.addEventListener('scroll', updateMenuPos, true)
    window.addEventListener('resize', updateMenuPos)
    requestAnimationFrame(() => searchRef.current?.focus())
    return () => {
      window.removeEventListener('scroll', updateMenuPos, true)
      window.removeEventListener('resize', updateMenuPos)
    }
  }, [branchMenuOpen, updateMenuPos])

  useEffect(() => {
    if (!worktreeMenuOpen) return
    updateWorktreeMenuPos()
    window.addEventListener('scroll', updateWorktreeMenuPos, true)
    window.addEventListener('resize', updateWorktreeMenuPos)
    return () => {
      window.removeEventListener('scroll', updateWorktreeMenuPos, true)
      window.removeEventListener('resize', updateWorktreeMenuPos)
    }
  }, [worktreeMenuOpen, updateWorktreeMenuPos])

  useEffect(() => {
    setSelectedIndex(0)
  }, [branchFilter])

  useEffect(() => {
    const activeItem = branchMenuOpen ? itemRefs.current[selectedIndex] : null
    activeItem?.scrollIntoView({ block: 'nearest' })
  }, [branchMenuOpen, selectedIndex])

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

  const warningMessage = useMemo(() => {
    if (context?.state !== 'ok' || !selectedBranch || useWorktree) return null
    if (selectedBranch.name !== context.currentBranch && context.dirty) {
      return t('repoLaunch.dirtyWarning')
    }
    if (selectedBranch.name !== context.currentBranch && selectedBranch.checkedOut) {
      return t('repoLaunch.checkedOutWarning')
    }
    return null
  }, [context, selectedBranch, t, useWorktree])

  const selectBranch = (candidate: RepositoryBranchInfo) => {
    onBranchChange(candidate.name)
    setBranchMenuOpen(false)
    setBranchFilter('')
  }

  const selectWorktreeMode = (enabled: boolean) => {
    onUseWorktreeChange(enabled)
    setWorktreeMenuOpen(false)
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
      setBranchMenuOpen(false)
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

  const worktreeLabel = useWorktree ? t('repoLaunch.worktreeIsolated') : t('repoLaunch.worktreeCurrent')
  const workbarButtonClassName = 'group inline-flex h-9 min-w-0 items-center gap-1.5 rounded-[7px] border border-transparent px-2.5 text-[13px] font-medium leading-none text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-container-lowest)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35 disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-[48px] min-w-0 flex-nowrap items-center justify-start gap-x-1.5 gap-y-1 overflow-hidden rounded-b-xl border-t border-[var(--color-border-separator)] bg-[var(--color-surface-container-low)] px-4 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
        <DirectoryPicker value={workDir} onChange={onWorkDirChange} variant="workbar" isGitProject={isGitReady} />

        {loading && workDir && (
          <div className="inline-flex h-9 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] text-[var(--color-text-secondary)]">
            <Loader2 size={14} className="shrink-0 animate-spin" />
            <span>{t('common.loading')}</span>
          </div>
        )}

        {isGitReady && (
          <>
            <span className="hidden h-4 w-px shrink-0 bg-[var(--color-border-separator)] opacity-70 sm:block" aria-hidden="true" />
            <button
              ref={branchButtonRef}
              type="button"
              disabled={disabled || loading || context.branches.length === 0}
              aria-haspopup="listbox"
              aria-expanded={branchMenuOpen}
              aria-label={`${t('repoLaunch.selectBranch')}: ${selectedBranch?.name || t('repoLaunch.noBranch')}`}
              title={selectedBranch?.name || t('repoLaunch.noBranch')}
              onClick={() => {
                setBranchMenuOpen((prev) => !prev)
                setWorktreeMenuOpen(false)
                setBranchFilter('')
              }}
              className={`${workbarButtonClassName} max-w-[260px] shrink`}
            >
              <GitBranch size={17} className="shrink-0 text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-secondary)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">
                {selectedBranch?.name || t('repoLaunch.noBranch')}
              </span>
              <ChevronDown size={16} className="shrink-0 text-[var(--color-text-tertiary)]" />
            </button>

            <button
              ref={worktreeButtonRef}
              type="button"
              disabled={disabled}
              aria-haspopup="listbox"
              aria-expanded={worktreeMenuOpen}
              aria-controls={worktreeMenuOpen ? worktreeListboxId : undefined}
              aria-label={`${t('repoLaunch.selectWorktree')}: ${worktreeLabel}`}
              title={worktreeLabel}
              onClick={() => {
                setWorktreeMenuOpen((prev) => !prev)
                setBranchMenuOpen(false)
              }}
              className={`${workbarButtonClassName} shrink-0 ${
                useWorktree
                  ? 'bg-[var(--color-surface-container-lowest)] text-[var(--color-text-primary)]'
                  : ''
              }`}
            >
              <GitFork size={17} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <span className="min-w-0 truncate">
                {worktreeLabel}
              </span>
              <ChevronDown size={16} className="shrink-0 text-[var(--color-text-tertiary)]" />
            </button>
          </>
        )}
      </div>

      {message && workDir && (
        <div className="flex items-center gap-2 px-1 text-[11px] text-[var(--color-text-tertiary)]">
          <AlertCircle size={13} className="shrink-0" />
          <span>
            {message === 'missing'
                ? t('repoLaunch.missingWorkdir')
                : message}
          </span>
        </div>
      )}

      {warningMessage && (
        <div className="flex items-center gap-2 px-1 text-[11px] text-[var(--color-warning)]">
          <AlertCircle size={13} className="shrink-0" />
          <span>{warningMessage}</span>
        </div>
      )}

      {branchMenuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          className="w-[390px] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]"
          style={{
            position: 'fixed',
            left: menuPos.left,
            ...(menuPos.direction === 'down'
              ? { top: menuPos.top }
              : { bottom: window.innerHeight - menuPos.top }),
            zIndex: 9999,
          }}
        >
          <div className="border-b border-[var(--color-border)] p-3">
            <label htmlFor={searchInputId} className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
              {t('repoLaunch.selectBranch')}
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2">
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
          </div>

          <div id={listboxId} role="listbox" aria-label={t('repoLaunch.selectBranch')} className="max-h-[280px] overflow-y-auto py-1">
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
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)]/35 ${
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
        </div>,
        document.body,
      )}

      {worktreeMenuOpen && worktreeMenuPos && createPortal(
        <div
          ref={worktreeMenuRef}
          className="w-[226px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 shadow-[var(--shadow-dropdown)]"
          style={{
            position: 'fixed',
            left: worktreeMenuPos.left,
            ...(worktreeMenuPos.direction === 'down'
              ? { top: worktreeMenuPos.top }
              : { bottom: window.innerHeight - worktreeMenuPos.top }),
            zIndex: 9999,
          }}
        >
          <div id={worktreeListboxId} role="listbox" aria-label={t('repoLaunch.selectWorktree')}>
            <button
              type="button"
              role="option"
              aria-selected={!useWorktree}
              onClick={() => selectWorktreeMode(false)}
              className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)]/35 disabled:cursor-not-allowed disabled:opacity-45 ${
                !useWorktree ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <GitFork size={16} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--color-text-primary)]">
                  {t('repoLaunch.worktreeCurrent')}
                </span>
              </span>
              {!useWorktree && <Check size={16} className="shrink-0 text-[var(--color-brand)]" />}
            </button>

            <button
              type="button"
              role="option"
              aria-selected={useWorktree}
              onClick={() => selectWorktreeMode(true)}
              className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)]/35 ${
                useWorktree ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <GitFork size={16} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--color-text-primary)]">
                  {t('repoLaunch.worktreeIsolated')}
                </span>
              </span>
              {useWorktree && <Check size={16} className="shrink-0 text-[var(--color-brand)]" />}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
