import { useState, useEffect, useId, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Plus,
  Search,
} from 'lucide-react'
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
      // Selected and keyboard-highlighted share the hover fill; the terracotta
      // check on the right is what marks the current project.
      className={`flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 text-left transition-colors hover:bg-[var(--color-surface-hover)] ${
        touch ? 'min-h-[56px] py-2.5' : 'min-h-8 py-1.5'
      } ${
        isSelected || highlighted ? 'bg-[var(--color-surface-hover)]' : ''
      }`}
    >
      {project.isGit ? (
        <FolderGit2 size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
      ) : (
        <Folder size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">
          {label}
        </div>
        <div className="truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">
          {project.realPath}
        </div>
      </div>
      {isSelected && (
        <Check size={14} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[var(--color-brand)]" />
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

  const actionRowClassName = `flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:bg-[var(--color-surface-hover)] focus-visible:outline-none ${
    touch ? 'min-h-11 py-2' : 'min-h-8 py-1.5'
  }`

  if (mode === 'browse') {
    return (
      <>
        <div className={`flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] pb-1 ${touch ? 'px-3 pt-1' : 'px-1'}`}>
          <button
            type="button"
            onClick={() => setMode('recent')}
            className="mr-1 inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
            {t('dirPicker.recent')}
          </button>
          <button onClick={() => loadBrowseDir('/')} className="font-mono text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">/</button>
          {browsePath.split('/').filter(Boolean).map((seg, i, arr) => (
            <span key={i} className="flex items-center gap-1">
              <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">/</span>
              <button
                onClick={() => loadBrowseDir('/' + arr.slice(0, i + 1).join('/'))}
                className="font-mono text-[11px] text-[var(--color-text-accent)] hover:underline"
              >{seg}</button>
            </span>
          ))}
        </div>

        <div className={`${touch ? 'px-1.5' : 'max-h-[240px]'} overflow-y-auto py-1`}>
          {loading ? (
            <LoadingState label={t('common.loading')} variant="block" size="sm" />
          ) : (
            <>
              {browseParent && browseParent !== browsePath && (
                <button onClick={() => loadBrowseDir(browseParent)} className="flex min-h-[30px] w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]">
                  <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                  <span className="text-[13px] text-[var(--color-text-secondary)]">..</span>
                </button>
              )}
              {browseEntries.length === 0 ? (
                <EmptyState description={t('dirPicker.noSubdirs')} variant="plain" size="sm" />
              ) : browseEntries.map((entry) => (
                <div
                  key={entry.path}
                  className="flex min-h-[30px] w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 transition-colors hover:bg-[var(--color-surface-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => loadBrowseDir(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Folder size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-primary)]">{entry.name}</span>
                  </button>
                  <Button variant="link" size="xs" onClick={() => handleSelect(entry.path)}>
                    {t('common.select')}
                  </Button>
                </div>
              ))}
            </>
          )}
        </div>

        <div className={`flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-1 ${touch ? 'px-3 pb-2' : 'px-1'}`}>
          <span className="min-w-0 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">{browsePath}</span>
          <Button size="sm" className="shrink-0" onClick={() => handleSelect(browsePath)}>
            {t('dirPicker.useThisFolder')}
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      {showRecentHeading && (
        <div className="px-2 pb-1 pt-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          {t('dirPicker.recent')}
        </div>
      )}
      {/* The menu-search row: a bare field over a hairline, not a boxed input
          inside a box. */}
      <div className={`mb-1 border-b border-[var(--color-border)] ${touch ? 'px-3' : ''}`}>
        <div className="flex h-8 items-center gap-2 px-2">
          <Search size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
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
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
        </div>
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-label={t('dirPicker.selectProject')}
        className={`${touch ? 'px-1.5' : 'max-h-[300px]'} overflow-y-auto`}
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
      <div className={`mt-1 border-t border-[var(--color-border)] pt-1 ${touch ? 'px-1.5 pb-1.5' : ''}`}>
        {onCreateProject && (
          <button
            type="button"
            onClick={onCreateProject}
            className={actionRowClassName}
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
            <span className="text-[13px] text-[var(--color-text-primary)]">{t('sidebar.newProject')}</span>
          </button>
        )}
        <button
          onClick={handleChooseFolder}
          className={actionRowClassName}
        >
          <FolderPlus size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="text-[13px] text-[var(--color-text-primary)]">{t('dirPicker.chooseFolder')}</span>
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
  // The workbar trigger is a form field (ProjectEditorModal's folder row), so it
  // takes the geometry of the secondary button it alternates with there: h-9,
  // 8px corner, a hairline that firms up on hover.
  const workbarTriggerClassName = (isMobileBrowser ? 'min-h-11 ' : '') + 'group inline-flex h-9 min-w-0 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-medium leading-none text-[var(--color-text-primary)] transition-[background-color,color,border-color] duration-150 ease-out hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-50'
  const triggerClassName = isWorkbar
    ? 'max-w-full ' + workbarTriggerClassName
    : 'inline-flex h-7 max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'
  const emptyTriggerClassName = isWorkbar
    ? workbarTriggerClassName
    : 'inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 text-xs text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]'

  const containerClassName = isWorkbar
    ? `relative min-w-0 ${isMobileBrowser ? 'flex-1' : 'max-w-[320px] shrink'}`
    : 'relative'

  const dropdownClassName = 'overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1 shadow-[var(--shadow-dropdown)]'
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
            <FolderGit2 size={isWorkbar ? 16 : 14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          ) : (
            <Folder size={isWorkbar ? 16 : 14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          )}
          <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">
            {selectedLabel}
          </span>
          <ChevronDown size={isWorkbar ? 16 : 14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={() => { setIsOpen(!isOpen); setMode('recent') }}
          className={emptyTriggerClassName}
          title={t('dirPicker.selectProject')}
        >
          <FolderOpen size={isWorkbar ? 16 : 14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
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
