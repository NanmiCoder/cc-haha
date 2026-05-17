import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { BookOpenText, ChevronDown, ChevronRight, Database, FileText, Folder, FolderGit2, RefreshCw, RotateCcw, Save, Search, X } from 'lucide-react'
import { Button } from '../components/shared/Button'
import { MarkdownRenderer } from '../components/markdown/MarkdownRenderer'
import { useTranslation } from '../i18n'
import { formatBytes } from '../lib/formatBytes'
import { useMemoryStore } from '../stores/memoryStore'
import { useSessionStore } from '../stores/sessionStore'
import { useUIStore } from '../stores/uiStore'
import type { MemoryFile, MemoryProject } from '../types/memory'

const DEFAULT_MEMORY_PATH = 'MEMORY.md'

export function MemorySettings() {
  const t = useTranslation()
  const {
    projects,
    files,
    selectedProjectId,
    selectedFile,
    draftContent,
    isLoadingProjects,
    isLoadingFiles,
    isLoadingFile,
    isSaving,
    error,
    lastSavedAt,
    fetchProjects,
    selectProject,
    fetchFiles,
    openFile,
    updateDraft,
    saveFile,
  } = useMemoryStore()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const pendingMemoryPath = useUIStore((s) => s.pendingMemoryPath)
  const setPendingMemoryPath = useUIStore((s) => s.setPendingMemoryPath)
  const [resourceQuery, setResourceQuery] = useState('')
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  )
  const activeCwd = activeSession?.workDir || activeSession?.projectPath || undefined
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null
  const isDirty = Boolean(selectedFile && draftContent !== selectedFile.content)
  const filteredProjects = useMemo(
    () => filterProjects(projects, resourceQuery, selectedProjectId, files),
    [files, projects, resourceQuery, selectedProjectId],
  )
  const filteredFiles = useMemo(
    () => filterFiles(files, resourceQuery),
    [files, resourceQuery],
  )
  const fileTree = useMemo(
    () => buildMemoryFileTree(filteredFiles),
    [filteredFiles],
  )
  const previewContent = stripMarkdownFrontmatter(draftContent)

  useEffect(() => {
    void fetchProjects(activeCwd)
  }, [activeCwd, fetchProjects])

  useEffect(() => {
    if (!selectedProjectId) return
    void fetchFiles(selectedProjectId)
  }, [fetchFiles, selectedProjectId])

  useEffect(() => {
    if (!selectedProjectId) return
    setExpandedProjectId(selectedProjectId)
  }, [selectedProjectId])

  useEffect(() => {
    if (!selectedProjectId || selectedFile || isLoadingFiles || isLoadingFile) return
    if (pendingMemoryPath) return
    const firstFile = files[0]
    if (firstFile) {
      void openFile(selectedProjectId, firstFile.path)
    }
  }, [files, isLoadingFile, isLoadingFiles, openFile, pendingMemoryPath, selectedFile, selectedProjectId])

  useEffect(() => {
    if (!pendingMemoryPath || isLoadingProjects || projects.length === 0) return
    const target = resolveMemoryFileTarget(projects, pendingMemoryPath)
    if (!target) {
      setPendingMemoryPath(null)
      return
    }
    if (selectedProjectId !== target.projectId) {
      selectProject(target.projectId)
      return
    }
    if (selectedFile?.path === target.path && !isLoadingFile) {
      setPendingMemoryPath(null)
      return
    }
    void openFile(target.projectId, target.path).then(() => {
      setPendingMemoryPath(null)
    })
  }, [
    isLoadingFile,
    isLoadingProjects,
    openFile,
    pendingMemoryPath,
    projects,
    selectProject,
    selectedFile?.path,
    selectedProjectId,
    setPendingMemoryPath,
  ])

  const handleRefresh = () => {
    void fetchProjects(activeCwd)
    if (selectedProjectId) {
      void fetchFiles(selectedProjectId)
    }
  }

  const handleProjectToggle = (projectId: string) => {
    if (expandedProjectId === projectId) {
      setExpandedProjectId(null)
      return
    }
    setExpandedProjectId(projectId)
    if (projectId !== selectedProjectId) {
      selectProject(projectId)
    }
  }

  const handleFileOpen = (file: MemoryFile) => {
    if (!selectedProjectId || file.path === selectedFile?.path) return
    void openFile(selectedProjectId, file.path)
  }

  const handlePreviewLinkClick = (href: string): boolean => {
    if (!selectedProjectId || !selectedFile) return false
    const targetPath = resolveMarkdownMemoryLink(
      href,
      selectedFile.path,
      selectedProject?.memoryDir,
      files,
    )
    if (!targetPath || targetPath === selectedFile.path) return false
    void openFile(selectedProjectId, targetPath)
    return true
  }

  const toggleFolder = (path: string) => {
    setCollapsedFolders((previous) => {
      const next = new Set(previous)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const forceExpandFiles = Boolean(resourceQuery.trim())

  return (
    <div className="flex h-full min-h-[640px] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
      <header className="grid min-h-[58px] border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="flex min-w-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 lg:border-b-0 lg:border-r">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-brand)]">
            <BookOpenText size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-[var(--color-text-primary)]">
              {t('settings.memory.title')}
            </h2>
            <p className="truncate text-xs text-[var(--color-text-tertiary)]">
              {t('settings.memory.projects')}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Breadcrumb
            project={selectedProject}
            filePath={selectedFile?.path}
            fallbackProject={activeCwd ? projectDisplayName(activeCwd) : '~/.claude/projects'}
            fallbackFile={t('settings.memory.noFileSelected')}
          />
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleRefresh}
              loading={isLoadingProjects || isLoadingFiles}
              icon={<RefreshCw size={15} aria-hidden="true" />}
            >
              {t('settings.memory.refresh')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!selectedFile || !isDirty || isSaving}
              onClick={() => selectedFile && updateDraft(selectedFile.content)}
              icon={<RotateCcw size={14} aria-hidden="true" />}
            >
              {t('settings.memory.revert')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!selectedFile || !isDirty}
              loading={isSaving}
              onClick={() => void saveFile()}
              icon={<Save size={14} aria-hidden="true" />}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </header>

      {error && (
        <div className="m-3 rounded-[var(--radius-md)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-hidden border-b border-[var(--color-border)] lg:border-b-0 lg:border-r">
          <section className="flex h-full min-h-0 flex-col bg-[var(--color-surface-container-lowest)]">
            <PanelHeader
              icon={<Database size={15} aria-hidden="true" />}
              title={t('settings.memory.resourceManager')}
              meta={isLoadingProjects ? t('common.loading') : undefined}
            />
            <div className="px-3 py-3">
              <SearchField
                value={resourceQuery}
                onChange={setResourceQuery}
                placeholder={t('settings.memory.resourceSearchPlaceholder')}
                ariaLabel={t('settings.memory.resourceSearchPlaceholder')}
                clearLabel={t('settings.memory.clearSearch')}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {projects.length === 0 && !isLoadingProjects ? (
                <EmptyState icon={<FolderGit2 size={18} />} text={t('settings.memory.emptyProjects')} />
              ) : filteredProjects.length === 0 ? (
                <EmptyState icon={<Search size={18} />} text={t('settings.memory.noProjectMatches')} />
              ) : (
                <div className="py-1">
                  {filteredProjects.map((project) => {
                    const isExpanded = project.id === expandedProjectId
                    const isSelected = project.id === selectedProjectId
                    const visibleFileTree = isSelected ? fileTree : []
                    return (
                      <ProjectTreeRow
                        key={project.id}
                        project={project}
                        expanded={isExpanded}
                        active={isSelected}
                        loading={isSelected && isLoadingFiles}
                        fileTree={visibleFileTree}
                        activePath={selectedFile?.path ?? null}
                        collapsedFolders={collapsedFolders}
                        forceExpanded={forceExpandFiles}
                        onToggle={() => handleProjectToggle(project.id)}
                        onToggleFolder={toggleFolder}
                        onFileSelect={handleFileOpen}
                        emptyText={t('settings.memory.emptyFiles')}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </section>
        </aside>

        <section className="min-h-0 overflow-hidden bg-[var(--color-surface-container-lowest)]">
          <div className="grid gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
                  {selectedFile?.path ? fileNameFromPath(selectedFile.path) : t('settings.memory.noFileSelected')}
                </h3>
                {isDirty && <Badge>{t('settings.memory.unsaved')}</Badge>}
                {lastSavedAt && !isDirty && <Badge>{t('settings.memory.saved')}</Badge>}
              </div>
              <p className="mt-1 truncate text-xs text-[var(--color-text-tertiary)]">
                {selectedProject?.memoryDir ?? t('settings.memory.selectProject')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
              {selectedFile ? (
                <>
                  <span>{formatBytes(selectedFile.bytes)}</span>
                  {selectedFile.updatedAt ? <span>{formatDate(selectedFile.updatedAt)}</span> : null}
                </>
              ) : null}
            </div>
          </div>

          {selectedFile ? (
            <div className="grid min-h-[560px] grid-rows-[minmax(300px,1fr)_minmax(260px,0.95fr)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-rows-1">
              <div className="min-h-0 border-b border-[var(--color-border)] 2xl:border-b-0 2xl:border-r">
                <div className="flex h-10 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 text-xs font-medium uppercase tracking-normal text-[var(--color-text-tertiary)]">
                  <span>{t('settings.memory.editor')}</span>
                  <span>MARKDOWN</span>
                </div>
                <textarea
                  aria-label={t('settings.memory.editor')}
                  value={draftContent}
                  onChange={(event) => updateDraft(event.target.value)}
                  spellCheck={false}
                  className="h-[calc(100%-40px)] w-full resize-none overflow-auto bg-transparent p-5 font-mono text-[13px] leading-6 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
                />
              </div>
              <div className="min-h-0 overflow-y-auto">
                <div className="flex h-10 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 text-xs font-medium uppercase tracking-normal text-[var(--color-text-tertiary)]">
                  <span>{t('settings.memory.preview')}</span>
                  <span>{t('settings.memory.rendered')}</span>
                </div>
                <div className="p-6">
                  <MarkdownRenderer
                    content={previewContent || ' '}
                    variant="document"
                    onLinkClick={handlePreviewLinkClick}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[520px] items-center justify-center p-8">
              <EmptyState icon={<FileText size={20} />} text={isLoadingFile ? t('common.loading') : t('settings.memory.selectFile')} />
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Breadcrumb({
  project,
  filePath,
  fallbackProject,
  fallbackFile,
}: {
  project: MemoryProject | null
  filePath?: string
  fallbackProject: string
  fallbackFile: string
}) {
  const projectLabel = project ? projectDisplayName(project.label) : fallbackProject
  const parts = filePath ? [projectLabel, ...filePath.split('/').filter(Boolean)] : [projectLabel, fallbackFile]
  return (
    <nav aria-label="Memory file path" className="flex min-w-0 items-center gap-1 text-sm text-[var(--color-text-tertiary)]">
      {parts.map((part, index) => {
        const isLast = index === parts.length - 1
        return (
          <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRight size={14} className="shrink-0" aria-hidden="true" /> : null}
            <span className={`truncate ${isLast ? 'font-semibold text-[var(--color-text-primary)]' : ''}`}>
              {part}
            </span>
          </span>
        )
      })}
    </nav>
  )
}

function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  clearLabel: string
}) {
  return (
    <div className="relative">
      <Search
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
        aria-hidden="true"
      />
      <input
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-9 text-sm text-[var(--color-text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]"
      />
      {value ? (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

function PanelHeader({ icon, title, meta }: { icon?: ReactNode; title: string; meta?: string }) {
  return (
    <div className="flex h-11 items-center justify-between border-b border-[var(--color-border)] px-3">
      <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
        {icon ? <span className="text-[var(--color-text-tertiary)]">{icon}</span> : null}
        <span className="truncate">{title}</span>
      </h3>
      {meta ? <span className="text-xs text-[var(--color-text-tertiary)]">{meta}</span> : null}
    </div>
  )
}

function ProjectTreeRow({
  project,
  expanded,
  active,
  loading,
  fileTree,
  activePath,
  collapsedFolders,
  forceExpanded,
  onToggle,
  onToggleFolder,
  onFileSelect,
  emptyText,
}: {
  project: MemoryProject
  expanded: boolean
  active: boolean
  loading: boolean
  fileTree: MemoryTreeNode[]
  activePath: string | null
  collapsedFolders: Set<string>
  forceExpanded: boolean
  onToggle: () => void
  onToggleFolder: (path: string) => void
  onFileSelect: (file: MemoryFile) => void
  emptyText: string
}) {
  const t = useTranslation()
  const display = projectDisplayName(project.label)
  return (
    <div className="mb-1">
      <button
        type="button"
        data-testid="memory-project-row"
        onClick={onToggle}
        title={project.label}
        aria-expanded={expanded}
        aria-label={t('settings.memory.toggleFolder', { name: display })}
        className={`group flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
          active
            ? 'bg-[var(--color-memory-surface)] text-[var(--color-text-primary)] ring-1 ring-inset ring-[var(--color-memory-border)]'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
        }`}
      >
        <Folder size={15} className="shrink-0 text-[var(--color-brand)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{display}</span>
        {!project.exists ? (
          <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">{t('settings.memory.missing')}</span>
        ) : null}
      </button>

      {expanded ? (
        <div className="ml-[18px] mt-1.5 border-l border-[var(--color-border)] pl-2.5">
          {loading ? (
            <div className="px-2 py-1.5 text-xs text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
          ) : fileTree.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-[var(--color-text-tertiary)]">{emptyText}</div>
          ) : (
            fileTree.map((node) => (
              <MemoryTreeRow
                key={node.id}
                node={node}
                depth={1}
                activePath={activePath}
                collapsedFolders={collapsedFolders}
                forceExpanded={forceExpanded}
                onToggleFolder={onToggleFolder}
                onFileSelect={onFileSelect}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function FileRow({
  file,
  active,
  onSelect,
  depth = 0,
}: {
  file: MemoryFile
  active: boolean
  onSelect: () => void
  depth?: number
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ paddingLeft: `${4 + Math.max(depth - 1, 0) * 16}px` }}
      className={`mb-1 flex min-h-8 w-full items-center gap-1.5 rounded-md border py-1 pr-2 text-left transition-colors focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
        active
          ? 'border-[var(--color-memory-border)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
          : 'border-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      <FileText size={14} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm">{file.title}</span>
    </button>
  )
}

function MemoryTreeRow({
  node,
  depth,
  activePath,
  collapsedFolders,
  forceExpanded,
  onToggleFolder,
  onFileSelect,
}: {
  node: MemoryTreeNode
  depth: number
  activePath: string | null
  collapsedFolders: Set<string>
  forceExpanded: boolean
  onToggleFolder: (path: string) => void
  onFileSelect: (file: MemoryFile) => void
}) {
  const t = useTranslation()
  if (node.kind === 'file') {
    return (
      <FileRow
        file={node.file}
        active={node.file.path === activePath}
        depth={depth}
        onSelect={() => onFileSelect(node.file)}
      />
    )
  }

  const isCollapsed = !forceExpanded && collapsedFolders.has(node.path)
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleFolder(node.path)}
        aria-expanded={!isCollapsed}
        aria-label={t('settings.memory.toggleFolder', { name: node.name })}
        className="mb-1 flex min-h-8 w-full items-center gap-1.5 rounded-md border border-transparent py-1 pr-2 text-left text-sm text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
        style={{ paddingLeft: `${4 + Math.max(depth - 1, 0) * 16}px` }}
      >
        {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        <Folder size={14} className="shrink-0 text-[var(--color-brand)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
      </button>
      {!isCollapsed ? (
        <div className="ml-[18px] mt-1 border-l border-[var(--color-border)] pl-2.5">
          {node.children.map((child) => (
            <MemoryTreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              collapsedFolders={collapsedFolders}
              forceExpanded={forceExpanded}
              onToggleFolder={onToggleFolder}
              onFileSelect={onFileSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Badge({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
      {children}
    </span>
  )
}

function EmptyState({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="grid place-items-center gap-2 px-3 py-8 text-center text-sm text-[var(--color-text-tertiary)]">
      {icon ? (
        <span className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-text-tertiary)]">
          {icon}
        </span>
      ) : null}
      <span>{text}</span>
    </div>
  )
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/\\/g, '/').replace(/\/+/g, '/').trim()
}

function filterProjects(
  projects: MemoryProject[],
  query: string,
  selectedProjectId: string | null,
  selectedProjectFiles: MemoryFile[],
): MemoryProject[] {
  const normalized = normalizeSearch(query)
  if (!normalized) return projects
  return projects.filter((project) =>
    normalizeSearch(`${project.label} ${project.memoryDir} ${project.id}`).includes(normalized) ||
    (project.id === selectedProjectId && selectedProjectFiles.some((file) =>
      normalizeSearch(`${file.title} ${file.path} ${file.description ?? ''} ${file.type ?? ''}`).includes(normalized),
    )),
  )
}

function filterFiles(files: MemoryFile[], query: string): MemoryFile[] {
  const normalized = normalizeSearch(query)
  if (!normalized) return files
  return files.filter((file) =>
    normalizeSearch(`${file.title} ${file.path} ${file.description ?? ''} ${file.type ?? ''}`).includes(normalized),
  )
}

function projectDisplayName(label: string): string {
  const normalized = label.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
  return parts[0] ?? label
}

function stripMarkdownFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end < 0) return content
  const after = content.indexOf('\n', end + 4)
  return after < 0 ? '' : content.slice(after + 1).trimStart()
}

function normalizeFsPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function resolveMemoryFileTarget(projects: MemoryProject[], absolutePath: string): { projectId: string; path: string } | null {
  const target = normalizeFsPath(absolutePath)
  for (const project of projects) {
    const memoryDir = normalizeFsPath(project.memoryDir)
    if (!memoryDir) continue
    if (target === memoryDir) {
      return { projectId: project.id, path: DEFAULT_MEMORY_PATH }
    }
    if (target.startsWith(`${memoryDir}/`)) {
      return {
        projectId: project.id,
        path: target.slice(memoryDir.length + 1),
      }
    }
  }
  return null
}

function resolveMarkdownMemoryLink(
  href: string,
  currentPath: string,
  projectMemoryDir: string | undefined,
  files: MemoryFile[],
): string | null {
  const rawHref = safeDecodeUriComponent(href.trim())
  if (!rawHref || rawHref.startsWith('#')) return null

  let target = rawHref
  try {
    const url = new URL(rawHref)
    if (url.protocol !== 'file:') return null
    target = url.pathname
  } catch {
    if (/^[a-z][a-z\d+.-]*:/i.test(rawHref)) return null
  }

  target = stripMarkdownLinkSuffix(target)
  if (!target || !target.endsWith('.md')) return null

  const absoluteTarget = normalizeFsPath(target)
  const memoryDir = projectMemoryDir ? normalizeFsPath(projectMemoryDir) : ''
  if (memoryDir) {
    if (absoluteTarget === memoryDir) return DEFAULT_MEMORY_PATH
    if (absoluteTarget.startsWith(`${memoryDir}/`)) {
      return findMemoryFileByPath(files, absoluteTarget.slice(memoryDir.length + 1))
    }
  }

  if (target.startsWith('/')) return null

  const currentParts = currentPath.split('/').filter(Boolean)
  const baseParts = currentParts.slice(0, -1)
  const resolvedParts: string[] = []
  for (const part of [...baseParts, ...target.split('/')]) {
    if (!part || part === '.') continue
    if (part === '..') {
      resolvedParts.pop()
      continue
    }
    resolvedParts.push(part)
  }

  return findMemoryFileByPath(files, resolvedParts.join('/'))
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stripMarkdownLinkSuffix(value: string): string {
  return value.split('#')[0]?.split('?')[0]?.trim() ?? ''
}

function findMemoryFileByPath(files: MemoryFile[], path: string): string | null {
  const normalized = normalizeFsPath(path)
  return files.find((file) => normalizeFsPath(file.path) === normalized)?.path ?? null
}

type MemoryTreeNode =
  | {
      kind: 'folder'
      id: string
      name: string
      path: string
      fileCount: number
      children: MemoryTreeNode[]
    }
  | {
      kind: 'file'
      id: string
      name: string
      path: string
      file: MemoryFile
    }

type MutableFolderNode = Extract<MemoryTreeNode, { kind: 'folder' }>

function buildMemoryFileTree(files: MemoryFile[]): MemoryTreeNode[] {
  const root: MutableFolderNode = {
    kind: 'folder',
    id: '__root__',
    name: '__root__',
    path: '',
    fileCount: 0,
    children: [],
  }

  const folders = new Map<string, MutableFolderNode>([['', root]])
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let parent = root
    parts.slice(0, -1).forEach((part, index) => {
      const folderPath = parts.slice(0, index + 1).join('/')
      let folder = folders.get(folderPath)
      if (!folder) {
        folder = {
          kind: 'folder',
          id: `folder:${folderPath}`,
          name: part,
          path: folderPath,
          fileCount: 0,
          children: [],
        }
        folders.set(folderPath, folder)
        parent.children.push(folder)
      }
      folder.fileCount += 1
      parent = folder
    })
    parent.children.push({
      kind: 'file',
      id: `file:${file.path}`,
      name: parts[parts.length - 1] ?? file.name,
      path: file.path,
      file,
    })
  }

  sortMemoryTree(root.children)
  return root.children
}

function sortMemoryTree(nodes: MemoryTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    const aIndex = a.kind === 'file' ? a.file.isIndex : false
    const bIndex = b.kind === 'file' ? b.file.isIndex : false
    if (aIndex !== bIndex) return aIndex ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const node of nodes) {
    if (node.kind === 'folder') sortMemoryTree(node.children)
  }
}

function fileNameFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
