import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { sessionsApi, type RecentProject } from '../../api/sessions'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'

type DropdownPos = {
  top: number
  left: number
  direction: 'up' | 'down'
}

type ProjectOption = {
  projectPath: string
  title: string
  subtitle: string | null
  isGit: boolean
  branch: string | null
  modifiedAt?: string
}

let cachedProjects: RecentProject[] | null = null
let cacheTimestamp = 0
const CACHE_TTL = 30_000

export function ProjectFilter() {
  const t = useTranslation()
  const { availableProjects, selectedProjects, setSelectedProjects } = useSessionStore()
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [loading, setLoading] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<DropdownPos | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const updateDropdownPos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const dropdownHeight = 420
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const direction = spaceBelow >= dropdownHeight || spaceBelow >= spaceAbove ? 'down' : 'up'

    setDropdownPos({
      top: direction === 'down' ? rect.bottom + 8 : rect.top - 8,
      left: rect.left,
      direction,
    })
  }, [])

  useEffect(() => {
    if (!open) return

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (dropdownRef.current?.contains(target)) return
      setOpen(false)
    }

    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  useEffect(() => {
    if (!open) return
    updateDropdownPos()
    window.addEventListener('scroll', updateDropdownPos, true)
    window.addEventListener('resize', updateDropdownPos)
    return () => {
      window.removeEventListener('scroll', updateDropdownPos, true)
      window.removeEventListener('resize', updateDropdownPos)
    }
  }, [open, updateDropdownPos])

  useEffect(() => {
    if (!open) return
    if (cachedProjects && Date.now() - cacheTimestamp < CACHE_TTL) {
      setProjects(cachedProjects)
      return
    }

    setLoading(true)
    sessionsApi.getRecentProjects(200)
      .then(({ projects: nextProjects }) => {
        cachedProjects = nextProjects
        cacheTimestamp = Date.now()
        setProjects(nextProjects)
      })
      .catch(() => setProjects([]))
      .finally(() => setLoading(false))
  }, [open])

  const isAllSelected = selectedProjects.length === 0

  const options = useMemo(() => {
    const availableSet = new Set(availableProjects)
    const optionsByPath = new Map<string, ProjectOption>()

    for (const project of projects) {
      if (!availableSet.has(project.projectPath)) continue
      optionsByPath.set(project.projectPath, {
        projectPath: project.projectPath,
        title: project.repoName || project.projectName,
        subtitle: project.realPath,
        isGit: project.isGit,
        branch: project.branch,
        modifiedAt: project.modifiedAt,
      })
    }

    for (const projectPath of availableProjects) {
      if (optionsByPath.has(projectPath)) continue
      optionsByPath.set(projectPath, {
        projectPath,
        title: fallbackProjectTitle(projectPath, t('sidebar.other')),
        subtitle: null,
        isGit: false,
        branch: null,
      })
    }

    return [...optionsByPath.values()].sort(compareProjectOptions)
  }, [availableProjects, projects, t])

  const optionByPath = useMemo(
    () => new Map(options.map((option) => [option.projectPath, option])),
    [options],
  )

  const label = isAllSelected
    ? t('sidebar.allProjects')
    : selectedProjects.length === 1
      ? optionByPath.get(selectedProjects[0]!)?.title || fallbackProjectTitle(selectedProjects[0]!, t('sidebar.other'))
      : `${selectedProjects.length} projects`

  const toggleProject = (projectPath: string) => {
    if (isAllSelected) {
      setSelectedProjects([projectPath])
      return
    }

    if (selectedProjects.includes(projectPath)) {
      const next = selectedProjects.filter((path) => path !== projectPath)
      setSelectedProjects(next.length === 0 ? [] : next)
      return
    }

    const next = [...selectedProjects, projectPath]
    setSelectedProjects(next.length >= availableProjects.length ? [] : next)
  }

  const selectAll = () => setSelectedProjects([])

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] px-3 py-2 text-sm font-medium text-[var(--color-text-primary)] shadow-[0_1px_0_rgba(255,255,255,0.6)] transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <span className="truncate max-w-[180px]">{label}</span>
        <ChevronIcon open={open} />
      </button>

      {open && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          className="w-[380px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[20px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]"
          style={{
            position: 'fixed',
            left: Math.min(dropdownPos.left, window.innerWidth - Math.min(380, window.innerWidth - 32) - 16),
            ...(dropdownPos.direction === 'down'
              ? { top: dropdownPos.top }
              : { bottom: window.innerHeight - dropdownPos.top }),
            boxShadow: 'var(--shadow-dropdown)',
            zIndex: 9999,
          }}
        >
          <div className="max-h-[360px] overflow-y-auto p-2">
            <button
              type="button"
              onClick={selectAll}
              className="flex w-full items-center gap-3 rounded-[16px] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <FolderIcon />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{t('sidebar.allProjects')}</div>
              </div>
              {isAllSelected && <CheckIcon />}
            </button>

            <div className="mx-3 my-2 border-t border-[var(--color-border)]" />

            {loading ? (
              <div className="px-4 py-6 text-center text-xs text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
            ) : options.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[var(--color-text-tertiary)]">{t('sidebar.noSessions')}</div>
            ) : (
              options.map((option) => {
                const checked = !isAllSelected && selectedProjects.includes(option.projectPath)
                return (
                  <button
                    key={option.projectPath}
                    type="button"
                    onClick={() => toggleProject(option.projectPath)}
                    className={`flex w-full items-center gap-3 rounded-[16px] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] ${
                      checked ? 'bg-[var(--color-surface-selected)]' : ''
                    }`}
                  >
                    {option.isGit ? <GitBranchIcon /> : <FolderIcon />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{option.title}</div>
                      {option.subtitle && (
                        <div className="truncate pt-0.5 text-[11px] text-[var(--color-text-tertiary)] font-[var(--font-mono)]">
                          {option.subtitle}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      {option.branch && (
                        <span className="max-w-[88px] truncate text-[10px] text-[var(--color-text-tertiary)]">
                          {option.branch}
                        </span>
                      )}
                      {checked && <CheckIcon />}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function compareProjectOptions(a: ProjectOption, b: ProjectOption) {
  if (a.modifiedAt && b.modifiedAt && a.modifiedAt !== b.modifiedAt) {
    return b.modifiedAt.localeCompare(a.modifiedAt)
  }
  if (a.modifiedAt && !b.modifiedAt) return -1
  if (!a.modifiedAt && b.modifiedAt) return 1
  return a.title.localeCompare(b.title)
}

function fallbackProjectTitle(projectPath: string, fallback: string) {
  if (!projectPath || projectPath === '_unknown') return fallback
  if (projectPath.includes('/')) {
    return projectPath.split('/').filter(Boolean).pop() || fallback
  }

  const segments = projectPath.split('-').filter(Boolean)
  return segments[segments.length - 1] || projectPath || fallback
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 text-[var(--color-text-secondary)]"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function GitBranchIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 text-[var(--color-text-secondary)]"
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-brand)"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
