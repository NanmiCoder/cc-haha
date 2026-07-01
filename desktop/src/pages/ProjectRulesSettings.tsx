import { useState, useEffect } from 'react'
import { useTranslation, type TranslationKey } from '../i18n'
import { Button } from '../components/shared/Button'
import { useSessionStore } from '../stores/sessionStore'
import { getDesktopHost } from '../lib/desktopHost'
import { api } from '../api/client'

type RuleFile = {
  path: string
  exists: boolean
  type: 'project' | 'user' | 'local'
  label: string
}

type ProjectEntry = {
  id: string
  label: string
  projectPath: string | null
  isCurrent: boolean
  files: RuleFile[]
}

type ProjectRulesResponse = {
  projects: ProjectEntry[]
  userFiles: RuleFile[]
  cwd: string
}

export function ProjectRulesSettings() {
  const t = useTranslation()
  const [data, setData] = useState<ProjectRulesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const cwd = activeSession?.workDir || activeSession?.projectPath || undefined

  const fetchRules = async () => {
    setLoading(true)
    try {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
      const res = await api.get<ProjectRulesResponse>(`/api/project-rules${query}`)
      setData(res)
      // Default-select the current project (or first project) once loaded.
      setSelectedProjectId((prev) => {
        if (prev && res.projects.some((p) => p.id === prev)) return prev
        const current = res.projects.find((p) => p.isCurrent)
        return current?.id ?? res.projects[0]?.id ?? null
      })
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRules()
  }, [cwd])

  const handleOpen = async (filePath: string) => {
    try {
      await getDesktopHost().shell.openPath(filePath)
    } catch {
      // ignore
    }
  }

  const handleCreate = async (scope: string, projectCwd?: string, filename?: string) => {
    try {
      await api.post(`/api/project-rules/create`, { scope, cwd: projectCwd || cwd, filename })
      await fetchRules()
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="material-symbols-outlined animate-spin text-[var(--color-text-muted)]">progress_activity</span>
      </div>
    )
  }

  if (!data) return null

  const selectedProject = data.projects.find((p) => p.id === selectedProjectId) ?? null

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)]">{t('settings.projectRules.title')}</h2>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">{t('settings.projectRules.description')}</p>
      </div>

      {/* User-level rules (always shown, apply globally) */}
      <Section title={t('settings.projectRules.userFile')} description={t('settings.projectRules.userFileDesc')}>
        {data.userFiles.map((file) => (
          <FileRow key={file.path} file={file} onOpen={handleOpen} onCreate={() => {
            if (file.label.includes('rules/')) handleCreate('user-rules', undefined, file.label.split('/').pop())
            else handleCreate('user')
          }} t={t} />
        ))}
      </Section>

      {/* Project selector + dynamic project rules */}
      <div className="border border-[var(--color-border)] rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-sm font-medium text-[var(--color-text)]">{t('settings.projectRules.projectFile')}</h3>
          {data.projects.length > 0 && (
            <select
              value={selectedProjectId ?? ''}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 max-w-[60%] text-[var(--color-text)]"
            >
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.isCurrent ? '★ ' : ''}{shortenPath(p.label)}
                </option>
              ))}
            </select>
          )}
        </div>

        {selectedProject ? (
          <div className="space-y-1">
            <p className="text-xs text-[var(--color-text-muted)] font-mono truncate" title={selectedProject.label}>
              {selectedProject.label}
            </p>
            {selectedProject.files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                onOpen={handleOpen}
                onCreate={() => {
                  const projectCwd = selectedProject.projectPath || undefined
                  if (file.label === 'CLAUDE.md') handleCreate('project-root', projectCwd)
                  else if (file.label === '.claude/CLAUDE.md') handleCreate('project', projectCwd)
                  else if (file.label === 'CLAUDE.local.md') handleCreate('local', projectCwd)
                }}
                t={t}
              />
            ))}
            <div className="flex gap-2 mt-2">
              <Button size="sm" variant="secondary" onClick={() => handleCreate('project-rules', selectedProject.projectPath || undefined, 'new-rule.md')}>
                <span className="material-symbols-outlined text-base mr-1">add</span>
                .claude/rules/
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">{t('settings.projectRules.notFound')}</p>
        )}
      </div>
    </div>
  )
}

function shortenPath(p: string): string {
  // Show last 2 segments for readability, full path is in title/tooltip below.
  const parts = p.split(/[/\\]/).filter(Boolean)
  if (parts.length <= 2) return p
  return '…' + (p.includes('\\') ? '\\' : '/') + parts.slice(-2).join(p.includes('\\') ? '\\' : '/')
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 space-y-2">
      <div>
        <h3 className="text-sm font-medium text-[var(--color-text)]">{title}</h3>
        <p className="text-xs text-[var(--color-text-muted)] font-mono truncate" title={description}>{description}</p>
      </div>
      {children}
    </div>
  )
}

function FileRow({ file, onOpen, onCreate, t }: {
  file: RuleFile
  onOpen: (path: string) => void
  onCreate: () => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[var(--color-surface-hover)]">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className={`material-symbols-outlined text-base ${file.exists ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]'}`}>
          {file.exists ? 'description' : 'note_add'}
        </span>
        <span className="text-sm font-mono truncate" title={file.path}>
          {file.label}
        </span>
      </div>
      <div className="ml-2 flex-shrink-0">
        {file.exists ? (
          <Button size="sm" variant="ghost" onClick={() => onOpen(file.path)}>
            <span className="material-symbols-outlined text-base mr-1">open_in_new</span>
            {t('settings.projectRules.open')}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={onCreate}>
            <span className="material-symbols-outlined text-base mr-1">add</span>
            {t('settings.projectRules.create')}
          </Button>
        )}
      </div>
    </div>
  )
}
