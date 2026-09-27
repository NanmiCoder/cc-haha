import { useState, useEffect, useId, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useDismissable } from '@/hooks/useDismissable'
import { sessionsApi, type RecentProject } from '../../api/sessions'
import { filesystemApi } from '../../api/filesystem'
import { useTranslation } from '../../i18n'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import {
  resolveProjectDisplayName,
  useProjectDisplayName,
  useProjectDisplayNameRevision,
} from '../../stores/projectDisplayNameStore'
import { getDesktopHost } from '../../lib/desktopHost'
import { fuzzyFilter } from '../../lib/fuzzyScore'
import {
  getCachedRecentProjects,
  invalidateRecentProjectsCache,
  setCachedRecentProjects,
} from '../../lib/recentProjectsCache'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/ui/LoadingState'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'

type Props = {
  value: string
  onChange: (path: string) => void
  variant?: 'chip' | 'workbar'
  isGitProject?: boolean
}

type DirEntry = { name: string; path: string; isDirectory: boolean }

export type DirectoryPanelMode = 'recent' | 'browse'

const DESKTOP_WORKTREE_MARKER = '/.claude/worktrees/'
const DROPDOWN_WIDTH = 400
const DROPDOWN_VIEWPORT_MARGIN = 12
const DROPDOWN_HEIGHT = 380 // approximate max height

function isDesktopRuntime() {
  return typeof window !== 'undefined' && getDesktopHost().isDesktop
}

function projectNameFromPath(filePath: string) {
  const displayRoot = filePath.includes(DESKTOP_WORKTREE_MARKER)
    ? filePath.slice(0, filePath.indexOf(DESKTOP_WORKTREE_MARKER))
    : filePath
  return displayRoot.split('/').filter(Boolean).pop() || filePath
}

function RecentProjectItem({
  id,
  project,
  value,
  touch,
  highlighted,
  itemRef,
  onHover,
  onSelect,
}: {
  id: string
  project: RecentProject
  value: string
  touch: boolean
  highlighted: boolean
  itemRef: (el: HTMLButtonElement | null) => void
  onHover: () => void
  onSelect: (path: string) => void
}) {
  const displayName = useProjectDisplayName(project.realPath)
  const isSelected = project.realPath === value
  const label = displayName || project.repoName || project.projectName

  return (
    <button
      id={id}
      ref={itemRef}
      type="button"
      role="option"
      aria-selected={isSelected}
      onMouseEnter={onHover}
      onClick={() => onSelect(project.realPath)}
      className={`flex w-full items-center gap-3 px-4 text-left transition-colors hover:bg-[var(--color-surface-hover)] ${
        touch ? 'min-h-[72px] py-3.5' : 'py-3'
      } ${
        isSelected ? 'bg-[var(--color-surface-selected)]' : highlighted ? 'bg-[var(--color-surface-hover)]' : ''
      }`}
    >
      {project.isGit ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 flex-shrink-0">
          <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
          <path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" />
        </svg>
      ) : (
        <span className="material-symbols-outlined w-5 flex-shrink-0 text-center text-[20px] text-[var(--color-text-secondary)]">folder</span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
          {label}
        </div>
        <div className="truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
          {project.realPath}
        </div>
      </div>
      {isSelected && (
        <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-brand)]" style={{ fontVariationSettings: "'FILL' 1" }}>
          check
        </span>
      )}
    </button>
  )
}

type PanelProps = {
  value: string
  /**
   * Fires for every way a directory can be chosen — a recent row, a browsed
   * folder, or the native dialog. The recent-project cache is invalidated
   * first so the next open reflects the new selection.
   */
  onSelect: (path: string) => void
  /** Touch density: 56/72px rows instead of the pointer-sized ones. */
  touch?: boolean
  /** The dropdown labels its own list; the bottom sheet has a title bar. */
  showRecentHeading?: boolean
  /**
   * Called before the native folder dialog takes over, for a host that has to
   * collapse its own overlay first.
   */
  onBeforeNativeDialog?: () => void
  onModeChange?: (mode: DirectoryPanelMode) => void
  /**
   * The host's trigger labels itself from the loaded projects, and this panel
   * is the only thing that fetches them.
   */
  onProjectsChange?: (projects: RecentProject[]) => void
  /**
   * Shows the "new project" row when set. The host owns the editor modal —
   * this panel unmounts when the host's overlay closes, so the modal cannot
   * live here. Hosts whose picker is itself a folder field inside the editor
   * (`ProjectEditorModal`) pass nothing, which is what keeps create dialogs
   * from stacking ad infinitum.
   */
  onCreateProject?: () => void
}

/**
 * The directory list itself — recent projects, a browse mode and the native
 * folder dialog — with no trigger and no positioning of its own.
 *
 * `DirectoryPicker` mounts it under its own dropdown; `RepositoryLaunchControls`
 * renders it as one view of the run-location menu. That second caller is the
 * reason this is not just inlined below: nesting a second portalled dropdown
 * inside that menu is what made choosing a directory in a fresh session cost
 * two clicks.
 */
export function RecentProjectsPanel({
  value,
  onSelect,
  touch = false,
  showRecentHeading = true,
  onBeforeNativeDialog,
  onModeChange,
  onProjectsChange,
  onCreateProject,
}: PanelProps) {
  const t = useTranslation()
  const [mode, setMode] = useState<DirectoryPanelMode>('recent')
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [browseEntries, setBrowseEntries] = useState<DirEntry[]>([])
  const [browsePath, setBrowsePath] = useState('')
  const [browseParent, setBrowseParent] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const searchInputId = useId()
  const listboxId = useId()
  const displayNameRevision = useProjectDisplayNameRevision()

  // Both callbacks fire from effects. Holding them in a ref means an inline
  // arrow from the caller cannot re-trigger the project load on every render.
  const onModeChangeRef = useRef(onModeChange)
  const onProjectsChangeRef = useRef(onProjectsChange)
  useEffect(() => {
    onModeChangeRef.current = onModeChange
    onProjectsChangeRef.current = onProjectsChange
  })

  useEffect(() => {
    onModeChangeRef.current?.(mode)
  }, [mode])

  // The panel only exists while its host is open, so mounting is the load
  // signal — no `isOpen` to thread through. The deep scan asks the server for
  // every project in the session history, not just the latest handful; the
  // 30s caches on both sides keep repeat opens cheap.
  useEffect(() => {
    if (mode !== 'recent') return
    const cachedProjects = getCachedRecentProjects()
    if (cachedProjects) {
      setProjects(cachedProjects)
      onProjectsChangeRef.current?.(cachedProjects)
      return
    }
    setLoading(true)
    sessionsApi.getRecentProjects(500, 5000)
      .then(({ projects: p }) => {
        setCachedRecentProjects(p)
        setProjects(p)
        onProjectsChangeRef.current?.(p)
      })
      .catch(() => setProjects([]))
      .finally(() => setLoading(false))
  }, [mode])

  // Pointer users get a focused search box on open; on touch that would only
  // pop the software keyboard over the list they came for.
  useEffect(() => {
    if (touch || mode !== 'recent') return
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [mode, touch])

  const filteredProjects = useMemo(() => {
    // Recompute when a rename lands even though `projects` itself is unchanged.
    void displayNameRevision
    return fuzzyFilter(projects, query, (project) => [
      resolveProjectDisplayName(project.realPath) || project.repoName || project.projectName,
      project.realPath,
    ])
  }, [projects, query, displayNameRevision])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Keep the keyboard-highlighted row visible while ArrowUp/Down move it.
  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, Math.max(filteredProjects.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const candidate = filteredProjects[selectedIndex]
      if (candidate) handleSelect(candidate.realPath)
    }
    // Escape intentionally falls through to the host's dismiss handler.
  }

  const loadBrowseDir = async (path?: string) => {
    setLoading(true)
    try {
      const result = await filesystemApi.browse(path)
      setBrowsePath(result.currentPath)
      setBrowseParent(result.parentPath)
      setBrowseEntries(result.entries)
    } catch { /* API not available */ }
    setLoading(false)
  }

  // Every selection path funnels through here, including the native dialog —
  // which used to call `onChange` directly and so left a stale cache behind.
  const handleSelect = (path: string) => {
    invalidateRecentProjectsCache()
    onSelect(path)
  }

  const handleChooseFolder = async () => {
    const host = getDesktopHost()
    if (host.isDesktop && host.capabilities.dialogs) {
      // Desktop: native OS folder dialog
      onBeforeNativeDialog?.()
      try {
        const selected = await host.dialogs.open({
          directory: true,
          multiple: false,
          title: t('dirPicker.chooseProjectFolder'),
        })
        if (typeof selected === 'string' && selected.length > 0) handleSelect(selected)
      } catch (err) {
        console.error('[DirectoryPicker] Failed to open folder dialog:', err)
      }
    } else {
      // Web browser: directory tree via backend API
      setMode('browse')
      loadBrowseDir(value || undefined)
    }
  }

  if (mode === 'browse') {
    return (
      <>
        <div className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] px-3 py-2">
          <Button variant="link" size="xs" className="mr-2" onClick={() => setMode('recent')}>
            {'← ' + t('dirPicker.recent')}
          </Button>
          <button onClick={() => loadBrowseDir('/')} className="text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">/</button>
          {browsePath.split('/').filter(Boolean).map((seg, i, arr) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--color-text-tertiary)]">/</span>
              <button
                onClick={() => loadBrowseDir('/' + arr.slice(0, i + 1).join('/'))}
                className="text-[10px] text-[var(--color-text-accent)] hover:underline"
              >{seg}</button>
            </span>
          ))}
        </div>

        <div className={`${touch ? '' : 'max-h-[240px]'} overflow-y-auto`}>
          {loading ? (
            <LoadingState label={t('common.loading')} variant="block" size="sm" />
          ) : (
            <>
              {browseParent && browseParent !== browsePath && (
                <button onClick={() => loadBrowseDir(browseParent)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-hover)]">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">arrow_upward</span>
                  <span className="text-xs text-[var(--color-text-secondary)]">..</span>
                </button>
              )}
              {browseEntries.length === 0 ? (
                <EmptyState description={t('dirPicker.noSubdirs')} variant="plain" size="sm" />
              ) : browseEntries.map((entry) => (
                <div
                  key={entry.path}
                  className="flex w-full items-center gap-2 px-3 py-2 hover:bg-[var(--color-surface-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => loadBrowseDir(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">folder</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-primary)]">{entry.name}</span>
                  </button>
                  <Button variant="link" size="xs" onClick={() => handleSelect(entry.path)}>
                    {t('common.select')}
                  </Button>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border)] px-3 py-2">
          <span className="truncate font-mono text-[10px] text-[var(--color-text-tertiary)]">{browsePath}</span>
          <Button size="base" onClick={() => handleSelect(browsePath)}>
            {t('dirPicker.useThisFolder')}
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      {showRecentHeading && (
        <div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
          {t('dirPicker.recent')}
        </div>
      )}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2">
          <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-tertiary)]">search</span>
          <input
            id={searchInputId}
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            aria-controls={listboxId}
            aria-activedescendant={filteredProjects[selectedIndex] ? `${listboxId}-option-${selectedIndex}` : undefined}
            placeholder={t('dirPicker.searchProjects')}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
        </div>
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-label={t('dirPicker.selectProject')}
        className={`${touch ? '' : 'max-h-[300px]'} overflow-y-auto`}
      >
        {loading ? (
          <LoadingState label={t('common.loading')} variant="block" size="sm" />
        ) : projects.length === 0 ? (
          <EmptyState description={t('dirPicker.noRecent')} variant="plain" size="sm" />
        ) : filteredProjects.length === 0 ? (
          <EmptyState description={t('dirPicker.noMatches')} variant="plain" size="sm" />
        ) : (
          filteredProjects.map((project, index) => (
            <RecentProjectItem
              key={project.projectPath}
              id={`${listboxId}-option-${index}`}
              project={project}
              value={value}
              touch={touch}
              highlighted={index === selectedIndex}
              itemRef={(el) => { itemRefs.current[index] = el }}
              onHover={() => setSelectedIndex(index)}
              onSelect={handleSelect}
            />
          ))
        )}
      </div>
      {/* Action rows stay out of the listbox: an `option` role would announce
          them as projects. */}
      <div className="border-t border-[var(--color-border)]">
        {onCreateProject && (
          <button
            type="button"
            onClick={onCreateProject}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            <span className="material-symbols-outlined text-[20px] text-[var(--color-text-tertiary)]">add</span>
            <span className="text-sm text-[var(--color-text-secondary)]">{t('sidebar.newProject')}</span>
          </button>
        )}
        <button
          onClick={handleChooseFolder}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <span className="material-symbols-outlined text-[20px] text-[var(--color-text-tertiary)]">create_new_folder</span>
          <span className="text-sm text-[var(--color-text-secondary)]">{t('dirPicker.chooseFolder')}</span>
        </button>
      </div>
    </>
  )
}

export function DirectoryPicker({ value, onChange, variant = 'chip', isGitProject = false }: Props) {
  const t = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [mode, setMode] = useState<DirectoryPanelMode>('recent')
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number; direction: 'up' | 'down' } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const isMobileBrowser = useMobileViewport() && !isDesktopRuntime()

  const dropdownRef = useRef<HTMLDivElement>(null)

  const updateDropdownPos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const direction = spaceBelow >= DROPDOWN_HEIGHT || spaceBelow >= spaceAbove ? 'down' : 'up'
    const width = Math.min(DROPDOWN_WIDTH, Math.max(0, window.innerWidth - DROPDOWN_VIEWPORT_MARGIN * 2))
    const maxLeft = Math.max(DROPDOWN_VIEWPORT_MARGIN, window.innerWidth - width - DROPDOWN_VIEWPORT_MARGIN)
    const left = Math.min(Math.max(rect.left, DROPDOWN_VIEWPORT_MARGIN), maxLeft)
    setDropdownPos({
      top: direction === 'down' ? rect.bottom + 4 : rect.top - 4,
      left,
      width,
      direction,
    })
  }, [])

  const close = useCallback(() => setIsOpen(false), [])

  // `ref` wraps the trigger, `dropdownRef` the portalled menu — both count as
  // inside. `stopEscapePropagation` because this picker is used inside modals
  // (AgentManager, McpSettings); without it one Escape would close the dialog
  // along with the menu.
  useDismissable({
    open: isOpen,
    refs: [ref, dropdownRef],
    onDismiss: close,
    stopEscapePropagation: true,
  })

  // Recalculate position on scroll/resize while open
  useEffect(() => {
    if (!isOpen) return
    updateDropdownPos()
    window.addEventListener('scroll', updateDropdownPos, true)
    window.addEventListener('resize', updateDropdownPos)
    return () => {
      window.removeEventListener('scroll', updateDropdownPos, true)
      window.removeEventListener('resize', updateDropdownPos)
    }
  }, [isOpen, updateDropdownPos])

  const handleSelect = (path: string) => {
    onChange(path)
    setIsOpen(false)
    setMode('recent')
  }

  // Find selected project info
  const selectedProject = projects.find((p) => p.realPath === value)
  const selectedProjectKey = selectedProject?.realPath ?? value
  const selectedDisplayName = useProjectDisplayName(selectedProjectKey)
  const isWorkbar = variant === 'workbar'
  const selectedLabel = selectedDisplayName || selectedProject?.repoName || selectedProject?.projectName || projectNameFromPath(value)
  const showGitIcon = selectedProject?.isGit || isGitProject
  const triggerClassName = isWorkbar
    ? 'max-w-full ' + (isMobileBrowser ? 'min-h-11 ' : '') + 'group inline-flex h-9 min-w-0 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-[13.5px] font-medium leading-none text-[var(--color-text-primary)] transition-[background-color,color,border-color] duration-150 ease-out hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-50'
    : 'flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface-container-low)] hover:bg-[var(--color-surface-hover)] rounded-full text-xs transition-colors border border-[var(--color-border)]'
  const emptyTriggerClassName = isWorkbar
    ? (isMobileBrowser ? 'min-h-11 ' : '') + 'group inline-flex h-9 min-w-0 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-[13.5px] font-medium leading-none text-[var(--color-text-primary)] transition-[background-color,color,border-color] duration-150 ease-out hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-50'
    : 'flex items-center gap-2 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors'

  const containerClassName = isWorkbar
    ? `relative min-w-0 ${isMobileBrowser ? 'flex-1' : 'max-w-[320px] shrink'}`
    : 'relative'

  const dropdownClassName = 'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]'
  const dropdownStyle = {
    position: 'fixed' as const,
    left: dropdownPos?.left,
    width: dropdownPos?.width,
    ...(dropdownPos?.direction === 'down'
      ? { top: dropdownPos.top }
      : { bottom: window.innerHeight - (dropdownPos?.top ?? 0) }),
    zIndex: 'var(--z-dropdown)',
  }
  const dropdownTitle = mode === 'recent' ? t('dirPicker.recent') : t('dirPicker.chooseProjectFolder')
  const dropdownContent = (
    <RecentProjectsPanel
      value={value}
      onSelect={handleSelect}
      touch={isMobileBrowser}
      showRecentHeading={!isMobileBrowser}
      onBeforeNativeDialog={() => setIsOpen(false)}
      onModeChange={setMode}
      onProjectsChange={setProjects}
    />
  )

  return (
    <div ref={ref} className={containerClassName}>
      {/* Trigger — shows selected project chip or placeholder */}
      {value ? (
        <button
          ref={triggerRef}
          onClick={() => { setIsOpen(!isOpen); setMode('recent') }}
          className={triggerClassName}
          title={value}
        >
          {showGitIcon ? (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-[var(--color-text-secondary)]">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          ) : (
            <span aria-hidden="true" className={`material-symbols-outlined shrink-0 ${isWorkbar ? 'text-[17px]' : 'text-[14px]'} text-[var(--color-text-secondary)]`}>folder</span>
          )}
          <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">
            {selectedLabel}
          </span>
          <span className={`${isWorkbar ? 'text-[15px]' : 'text-[12px]'} material-symbols-outlined shrink-0 text-[var(--color-text-tertiary)]`}>expand_more</span>
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={() => { setIsOpen(!isOpen); setMode('recent') }}
          className={emptyTriggerClassName}
          title={t('dirPicker.selectProject')}
        >
          <span aria-hidden="true" className={`material-symbols-outlined shrink-0 ${isWorkbar ? 'text-[17px]' : 'text-[14px]'}`}>folder_open</span>
          <span className="min-w-0 truncate">{t('dirPicker.selectProject')}</span>
        </button>
      )}

      {isOpen && dropdownPos && (
        isMobileBrowser ? (
          <MobileBottomSheet
            open={isOpen}
            onClose={() => setIsOpen(false)}
            title={dropdownTitle}
            closeLabel={t('tabs.close')}
            panelRef={dropdownRef}
          >
            {dropdownContent}
          </MobileBottomSheet>
        ) : createPortal(
          <div
            ref={dropdownRef}
            data-testid="directory-picker-menu"
            className={dropdownClassName}
            style={dropdownStyle}
          >
            {dropdownContent}
          </div>,
          document.body,
        )
      )}
    </div>
  )
}
