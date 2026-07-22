import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Bot,
  Box,
  Boxes,
  Bolt,
  Braces,
  Check,
  ChevronDown,
  CircleAlert,
  Folder,
  Hammer,
  Layers,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Terminal,
  Trash2,
  User,
  Wrench,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import type {
  AgentDefinition,
  AgentMutationInput,
  AgentScope,
  AgentSource,
} from '../../api/agents'
import { useAgentStore } from '../../stores/agentStore'
import { useSessionStore } from '../../stores/sessionStore'
import { getSessionBrowsablePath } from '../../lib/sessionWorkspace'
import { useUIStore } from '../../stores/uiStore'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { Button } from '../shared/Button'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { DirectoryPicker } from '../shared/DirectoryPicker'
import { Dropdown } from '../shared/Dropdown'
import { Input } from '../shared/Input'
import { Modal } from '../shared/Modal'

const AGENT_COLORS: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  cyan: '#06b6d4',
}

const AGENT_SOURCE_ORDER: AgentSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'policySettings',
  'plugin',
  'flagSettings',
  'built-in',
]

const BUILT_IN_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/
type ToolAccessMode = 'inherit' | 'none' | 'custom'
type ToolCategory = 'readSearch' | 'modify' | 'execute' | 'workflow' | 'other'

const TOOL_CATEGORY_ORDER: ToolCategory[] = ['readSearch', 'modify', 'execute', 'workflow', 'other']
const TOOL_METADATA: Record<string, { category: ToolCategory; description: TranslationKey }> = {
  Read: { category: 'readSearch', description: 'settings.agents.form.toolDescription.Read' },
  Glob: { category: 'readSearch', description: 'settings.agents.form.toolDescription.Glob' },
  Grep: { category: 'readSearch', description: 'settings.agents.form.toolDescription.Grep' },
  WebFetch: { category: 'readSearch', description: 'settings.agents.form.toolDescription.WebFetch' },
  WebSearch: { category: 'readSearch', description: 'settings.agents.form.toolDescription.WebSearch' },
  Edit: { category: 'modify', description: 'settings.agents.form.toolDescription.Edit' },
  Write: { category: 'modify', description: 'settings.agents.form.toolDescription.Write' },
  NotebookEdit: { category: 'modify', description: 'settings.agents.form.toolDescription.NotebookEdit' },
  Bash: { category: 'execute', description: 'settings.agents.form.toolDescription.Bash' },
  PowerShell: { category: 'execute', description: 'settings.agents.form.toolDescription.PowerShell' },
  TodoWrite: { category: 'workflow', description: 'settings.agents.form.toolDescription.TodoWrite' },
  Skill: { category: 'workflow', description: 'settings.agents.form.toolDescription.Skill' },
  ToolSearch: { category: 'workflow', description: 'settings.agents.form.toolDescription.ToolSearch' },
  EnterWorktree: { category: 'workflow', description: 'settings.agents.form.toolDescription.EnterWorktree' },
  ExitWorktree: { category: 'workflow', description: 'settings.agents.form.toolDescription.ExitWorktree' },
  StructuredOutput: { category: 'workflow', description: 'settings.agents.form.toolDescription.StructuredOutput' },
}

function getAgentProjectPath(agent?: AgentDefinition): string | undefined {
  if (agent?.source !== 'projectSettings' || !agent.baseDir) return undefined
  const normalized = agent.baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const suffix = '/.claude/agents'
  if (!normalized.toLowerCase().endsWith(suffix)) return undefined
  const projectPath = normalized.slice(0, -suffix.length)
  if (!projectPath) return '/'
  return /^[A-Za-z]:$/.test(projectPath) ? `${projectPath}/` : projectPath
}

export function AgentManager() {
  const {
    activeAgents,
    allAgents,
    isLoading,
    error,
    mutationWarning,
    selectedAgent,
    selectedAgentReturnTab,
    fetchAgents,
    retryMutationRefresh,
    selectAgent,
  } = useAgentStore()
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const t = useTranslation()
  const [formState, setFormState] = useState<{ mode: 'create' | 'edit'; agent?: AgentDefinition } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AgentDefinition | null>(null)

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = getSessionBrowsablePath(activeSession)
  const [agentContextPath, setAgentContextPath] = useState<string | undefined>(currentWorkDir)
  const contextSessionId = sessions.find(
    (session) => getSessionBrowsablePath(session) === agentContextPath,
  )?.id

  useEffect(() => {
    setAgentContextPath(currentWorkDir)
    void fetchAgents(currentWorkDir)
  }, [fetchAgents, currentWorkDir])

  const groupedAgents = useMemo(() => {
    const groups: Partial<Record<AgentSource, AgentDefinition[]>> = {}
    for (const agent of allAgents) {
      ;(groups[agent.source] ??= []).push(agent)
    }
    return groups
  }, [allAgents])

  const sourceCount = AGENT_SOURCE_ORDER.filter((source) => (groupedAgents[source] ?? []).length > 0).length
  const handleAgentBack = () => {
    const returnTab = selectedAgentReturnTab
    selectAgent(null)
    if (returnTab === 'plugins') useUIStore.getState().setPendingSettingsTab('plugins')
  }

  return (
    <div className="w-full min-w-0">
      {mutationWarning && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning-container)] px-4 py-3"
          role="status"
        >
          <div className="flex min-w-0 items-start gap-2">
            <CircleAlert size={17} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.agents.refreshWarning')}
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => void retryMutationRefresh(
              agentContextPath,
              contextSessionId,
            )}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {selectedAgent ? (
        <AgentDetailView
          agent={selectedAgent}
          onBack={handleAgentBack}
          onEdit={() => setFormState({ mode: 'edit', agent: selectedAgent })}
          onDelete={() => setDeleteTarget(selectedAgent)}
        />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">
                {t('settings.agents.title')}
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--color-text-secondary)]">
                {t('settings.agents.description')}
              </p>
            </div>
            <Button icon={<Plus size={16} />} onClick={() => setFormState({ mode: 'create' })}>
              {t('settings.agents.create')}
            </Button>
          </div>

          {isLoading && allAgents.length === 0 ? (
            <div className="flex justify-center py-12" role="status" aria-label={t('common.loading')}>
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-brand)] border-t-transparent" />
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 px-5 py-10 text-center">
              <p className="mb-3 text-sm text-[var(--color-error)]">{t('settings.agents.loadError')}</p>
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw size={14} />}
                onClick={() => void fetchAgents(agentContextPath)}
              >
                {t('common.retry')}
              </Button>
            </div>
          ) : allAgents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-12 text-center">
              <Bot className="mx-auto mb-3 text-[var(--color-text-tertiary)]" size={40} />
              <p className="mb-1 text-sm text-[var(--color-text-secondary)]">{t('settings.agents.empty')}</p>
              <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.agents.emptyHint')}</p>
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-6">
              <section className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
                <div className="grid min-w-0 gap-4 px-5 py-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] xl:items-end">
                  <div className="min-w-0">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">
                      {t('settings.agents.browserEyebrow')}
                    </div>
                    <div className="mb-2 flex items-center gap-3">
                      <Bot size={22} className="text-[var(--color-brand)]" />
                      <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
                        {t('settings.agents.browserTitle')}
                      </h3>
                    </div>
                  </div>
                  <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3">
                    <SummaryCard label={t('settings.agents.summary.totalAgents')} value={String(allAgents.length)} icon={<Bot size={14} />} />
                    <SummaryCard label={t('settings.agents.summary.activeAgents')} value={String(activeAgents.length)} icon={<Bolt size={14} />} />
                    <SummaryCard label={t('settings.agents.summary.sources')} value={String(sourceCount)} icon={<Layers size={14} />} className="col-span-2 sm:col-span-1" />
                  </div>
                </div>
              </section>

              <div className={`grid gap-4 ${sourceCount >= 2 ? 'xl:grid-cols-2' : ''}`}>
                {AGENT_SOURCE_ORDER.map((source) => {
                  const group = groupedAgents[source]
                  if (!group?.length) return null
                  const sourceLabel = t(`settings.agents.source.${source}`)
                  return (
                    <section key={source} className="min-w-0 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-4">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${getAgentSourceAccentClass(source)}`}>
                            {getAgentSourceIcon(source)}
                          </span>
                          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{sourceLabel}</h4>
                          <span className="text-xs text-[var(--color-text-tertiary)]">{group.length}</span>
                        </div>
                        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
                          {t('settings.agents.groupHint', { source: sourceLabel, count: String(group.length) })}
                        </p>
                      </div>
                      <div className="flex flex-col p-2">
                        {group.map((agent, index) => (
                          <button
                            key={`${agent.source}-${agent.agentType}-${agent.target ?? agent.baseDir ?? index}`}
                            onClick={() => selectAgent(agent, 'agents')}
                            className="group rounded-xl border border-transparent px-3 py-3 text-left transition-all hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                          >
                            <div className="flex items-start gap-3">
                              <Bot size={18} className="mt-0.5 shrink-0" style={{ color: getAgentDotColor(agent.color) }} />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="break-all text-sm font-bold text-[var(--color-text-primary)]">{agent.agentType}</span>
                                  {agent.modelDisplay && <MetaPill>{agent.modelDisplay}</MetaPill>}
                                  {agent.effort !== undefined && <MetaPill>{agent.effort}</MetaPill>}
                                  <MetaPill>{sourceLabel}</MetaPill>
                                  <MetaPill>{agent.isActive ? t('settings.agents.status.active') : t('settings.agents.status.available')}</MetaPill>
                                  {agent.overriddenBy && (
                                    <MetaPill>{t('settings.agents.overriddenBy', { source: t(`settings.agents.source.${agent.overriddenBy}`) })}</MetaPill>
                                  )}
                                </div>
                                <div className="mt-1 break-words text-xs leading-5 text-[var(--color-text-secondary)] [&_.prose]:text-xs [&_.prose]:leading-5 [&_.prose]:text-[var(--color-text-secondary)]">
                                  <MarkdownRenderer content={agent.description || t('settings.agents.noDescription')} />
                                </div>
                                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
                                  <span>{agent.tools === undefined
                                    ? t('settings.agents.noTools')
                                    : agent.tools.length === 0
                                      ? t('settings.agents.disabledTools')
                                      : t('settings.agents.toolCount', { count: String(agent.tools.length) })}</span>
                                  {(agent.target || agent.baseDir) && <span className="break-all">{agent.target || agent.baseDir}</span>}
                                </div>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {formState && (
        <AgentFormModal
          mode={formState.mode}
          agent={formState.agent}
          cwd={agentContextPath}
          sessionId={contextSessionId}
          onProjectContextChange={setAgentContextPath}
          onClose={() => setFormState(null)}
        />
      )}
      <AgentDeleteDialog
        agent={deleteTarget}
        cwd={agentContextPath}
        sessionId={contextSessionId}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}

function AgentDetailView({
  agent,
  onBack,
  onEdit,
  onDelete,
}: {
  agent: AgentDefinition
  onBack: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useTranslation()
  const sourceLabel = t(`settings.agents.source.${agent.source}`)
  const editable = isEditableAgent(agent)
  const inherited = t('settings.agents.detail.inherit')

  return (
    <div className="flex h-full min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={16} />} onClick={onBack}>
          {t('settings.agents.backToList')}
        </Button>
        {editable ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={onEdit}>
              {t('settings.agents.edit')}
            </Button>
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={onDelete}>
              {t('settings.agents.delete')}
            </Button>
          </div>
        ) : (
          <MetaPill><LockKeyhole size={11} /> {t('settings.agents.readOnly')}</MetaPill>
        )}
      </div>

      <section className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
        <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(340px,1fr)] lg:items-start">
          <div className="min-w-0">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">{t('settings.agents.entryEyebrow')}</div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: getAgentDotColor(agent.color) }} />
              <h3 className="break-all text-[22px] font-semibold leading-tight text-[var(--color-text-primary)]">{agent.agentType}</h3>
              <MetaPill>{sourceLabel}</MetaPill>
              <MetaPill>{agent.isActive ? t('settings.agents.status.active') : t('settings.agents.status.available')}</MetaPill>
              {agent.overriddenBy && (
                <MetaPill>{t('settings.agents.overriddenByShort', { source: t(`settings.agents.source.${agent.overriddenBy}`) })}</MetaPill>
              )}
            </div>
            <div className="max-w-4xl text-sm leading-6 text-[var(--color-text-secondary)]">
              <MarkdownRenderer content={agent.description || t('settings.agents.noDescription')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <DetailStat label={t('settings.agents.detail.configuredModel')} value={agent.model || inherited} icon={<Braces size={14} />} />
            <DetailStat label={t('settings.agents.detail.configuredEffort')} value={agent.effort === undefined ? inherited : String(agent.effort)} icon={<Hammer size={14} />} />
            <DetailStat
              label={t('settings.agents.summary.tools')}
              value={agent.tools === undefined
                ? t('settings.agents.noTools')
                : agent.tools.length === 0
                  ? t('settings.agents.disabledTools')
                  : t('settings.agents.toolCount', { count: String(agent.tools.length) })}
              icon={<Wrench size={14} />}
            />
            <p className="col-span-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {t('settings.agents.detail.effortHint')}
            </p>
          </div>
        </div>
      </section>

      {agent.tools && agent.tools.length > 0 && (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
          <div className="mb-3 flex items-center gap-2">
            <Wrench size={18} className="text-[var(--color-text-tertiary)]" />
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.agents.tools')}</h4>
          </div>
          <div className="flex flex-wrap gap-2">{agent.tools.map((tool) => <MetaPill key={tool}>{tool}</MetaPill>)}</div>
        </section>
      )}

      <section className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
            <div className="min-w-0">
              <div className="break-all font-mono text-xs text-[var(--color-text-secondary)]">{agent.target || agent.baseDir || sourceLabel}</div>
              <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">{t('settings.agents.promptHint')}</div>
            </div>
            <MetaPill>{t('settings.agents.systemPrompt')}</MetaPill>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-surface-container-lowest)]">
            {agent.systemPrompt ? (
              <div className="px-6 py-5 lg:px-8">
                <MarkdownRenderer content={agent.systemPrompt} variant="document" className="mx-auto max-w-[72ch]" />
              </div>
            ) : (
              <div className="px-6 py-10 text-center text-sm text-[var(--color-text-tertiary)]">{t('settings.agents.noSystemPrompt')}</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function AgentFormModal({
  mode,
  agent,
  cwd,
  sessionId,
  onProjectContextChange,
  onClose,
}: {
  mode: 'create' | 'edit'
  agent?: AgentDefinition
  cwd?: string
  sessionId?: string
  onProjectContextChange: (path: string) => void
  onClose: () => void
}) {
  const t = useTranslation()
  const createAgent = useAgentStore((state) => state.createAgent)
  const updateAgent = useAgentStore((state) => state.updateAgent)
  const isMutating = useAgentStore((state) => state.isMutating)
  const availableTools = useAgentStore((state) => state.availableTools)
  const sessions = useSessionStore((state) => state.sessions)
  const initialScope = agent?.source === 'projectSettings' ? 'project' : 'user'
  const initialModel = agent?.model || 'inherit'
  const [scope, setScope] = useState<AgentScope>(initialScope)
  const [projectPath, setProjectPath] = useState(
    initialScope === 'project' ? getAgentProjectPath(agent) || cwd || '' : cwd || '',
  )
  const [name, setName] = useState(agent?.agentType || '')
  const [description, setDescription] = useState(agent?.description || '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '')
  const [modelChoice, setModelChoice] = useState(
    initialModel === 'inherit' || BUILT_IN_MODELS.includes(initialModel as typeof BUILT_IN_MODELS[number])
      ? initialModel
      : 'custom',
  )
  const [customModel, setCustomModel] = useState(modelChoice === 'custom' ? initialModel : '')
  const initialEffort = agent?.effort === undefined ? 'inherit' : String(agent.effort)
  const hasLegacyEffort = initialEffort !== 'inherit' && !EFFORTS.includes(initialEffort as typeof EFFORTS[number])
  const [effort, setEffort] = useState(initialEffort)
  const initialToolAccess: ToolAccessMode = agent?.tools === undefined
    ? 'inherit'
    : agent.tools.length === 0
      ? 'none'
      : 'custom'
  const [toolAccess, setToolAccess] = useState<ToolAccessMode>(initialToolAccess)
  const initialTools = agent?.tools ?? []
  const [selectedBuiltInTools, setSelectedBuiltInTools] = useState(
    initialTools.filter(tool => availableTools.includes(tool)),
  )
  const [customTools, setCustomTools] = useState(
    initialTools.filter(tool => !availableTools.includes(tool)).join(', '),
  )
  const [toolsDirty, setToolsDirty] = useState(false)
  const parsedTools = useMemo(
    () => [...new Set([...selectedBuiltInTools, ...parseTools(customTools)])],
    [customTools, selectedBuiltInTools],
  )
  const [color, setColor] = useState(agent?.color || '')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const nextErrors: Record<string, string> = {}
    const trimmedName = name.trim()
    if (!NAME_PATTERN.test(trimmedName)) nextErrors.name = t('settings.agents.form.nameError')
    if (!description.trim()) nextErrors.description = t('settings.agents.form.descriptionRequired')
    if (mode === 'create' && !systemPrompt.trim()) nextErrors.systemPrompt = t('settings.agents.form.systemPromptRequired')
    if (modelChoice === 'custom' && !customModel.trim()) nextErrors.customModel = t('settings.agents.form.customModelRequired')
    if (toolAccess === 'custom' && parsedTools.length === 0) nextErrors.tools = t('settings.agents.form.toolsCustomRequired')
    if (scope === 'project' && !projectPath) nextErrors.scope = t('settings.agents.form.projectUnavailable')
    setFieldErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const toolSelectionIsUnchanged = mode === 'edit' &&
      toolAccess === initialToolAccess &&
      (toolAccess !== 'custom' || !toolsDirty)
    const targetCwd = scope === 'project' ? projectPath : cwd
    const input: AgentMutationInput = {
      scope,
      ...(targetCwd ? { cwd: targetCwd } : {}),
      ...(mode === 'edit' && agent?.target ? { target: agent.target } : {}),
      name: trimmedName,
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      ...(mode === 'edit'
        ? { model: modelChoice === 'inherit' ? null : modelChoice === 'custom' ? customModel.trim() : modelChoice }
        : modelChoice === 'inherit' ? {} : { model: modelChoice === 'custom' ? customModel.trim() : modelChoice }),
      ...(mode === 'edit'
        ? { effort: effort === 'inherit' ? null : typeof agent?.effort === 'number' && effort === initialEffort ? agent.effort : effort }
        : effort === 'inherit' ? {} : { effort }),
      ...(mode === 'edit'
        ? {
            tools: toolSelectionIsUnchanged
              ? agent?.tools ?? null
              : toolAccess === 'inherit'
                ? null
                : toolAccess === 'none'
                  ? []
                  : parsedTools,
          }
        : toolAccess === 'inherit' ? {} : { tools: toolAccess === 'none' ? [] : parsedTools }),
      ...(mode === 'edit' ? { color: color || null } : color ? { color } : {}),
    }

    setSubmitError(null)
    try {
      const targetSessionId = scope === 'project'
        ? sessions.find((session) => getSessionBrowsablePath(session) === projectPath)?.id
        : sessionId
      if (mode === 'edit' && agent) {
        await updateAgent(agent.agentType, input, targetSessionId)
      } else {
        await createAgent(input, targetSessionId)
      }
      if (scope === 'project' && targetCwd) onProjectContextChange(targetCwd)
      onClose()
    } catch {
      setSubmitError(t('settings.agents.form.saveError'))
    }
  }

  return (
    <Modal
      open
      onClose={isMutating ? () => {} : onClose}
      title={mode === 'edit' ? t('settings.agents.editTitle') : t('settings.agents.createTitle')}
      width={680}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={isMutating}>{t('common.cancel')}</Button>
          <Button onClick={() => void handleSubmit()} loading={isMutating}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="grid gap-4">
        <Field label={t('settings.agents.form.scope')} error={fieldErrors.scope} required>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('settings.agents.form.scope')}>
            {([
              { value: 'user' as const, label: t('settings.agents.form.scopeUser'), icon: <User size={16} /> },
              { value: 'project' as const, label: t('settings.agents.form.scopeProject'), icon: <Folder size={16} /> },
            ]).map((option) => {
              const selected = scope === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  disabled={mode === 'edit'}
                  onClick={() => setScope(option.value)}
                  className={`flex min-h-16 items-center gap-3 rounded-[var(--radius-lg)] border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                  }`}
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    selected ? 'bg-[var(--color-primary-fixed)] text-[var(--color-brand)]' : 'bg-[var(--color-surface-container-high)]'
                  }`}>
                    {option.icon}
                  </span>
                  <span className="text-sm font-semibold">{option.label}</span>
                </button>
              )
            })}
          </div>
          {scope === 'project' && (
            <div className="mt-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">
                    {projectPath
                      ? t('settings.agents.form.projectTarget', { path: projectPath })
                      : t('settings.agents.form.projectUnavailable')}
                  </p>
                </div>
                {mode === 'create' && (
                  <DirectoryPicker value={projectPath} onChange={setProjectPath} />
                )}
              </div>
            </div>
          )}
        </Field>

        <Input
          label={t('settings.agents.form.name')}
          required
          value={name}
          disabled={mode === 'edit'}
          error={fieldErrors.name}
          placeholder={t('settings.agents.form.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          label={t('settings.agents.form.description')}
          required
          value={description}
          error={fieldErrors.description}
          placeholder={t('settings.agents.form.descriptionPlaceholder')}
          onChange={(event) => setDescription(event.target.value)}
        />

        <Field
          label={t('settings.agents.form.systemPrompt')}
          error={fieldErrors.systemPrompt}
          required={mode === 'create'}
        >
          <textarea
            aria-label={t('settings.agents.form.systemPrompt')}
            value={systemPrompt}
            rows={7}
            placeholder={t('settings.agents.form.systemPromptPlaceholder')}
            onChange={(event) => setSystemPrompt(event.target.value)}
            className={`${textAreaClassName} ${fieldErrors.systemPrompt ? 'border-[var(--color-error)]' : ''}`}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.agents.form.model')}>
            <AgentSelect
              label={t('settings.agents.form.model')}
              value={modelChoice}
              onChange={setModelChoice}
              items={[
                { value: 'inherit', label: t('settings.agents.form.inherit') },
                ...BUILT_IN_MODELS.map((model) => ({ value: model, label: model })),
                { value: 'custom', label: t('settings.agents.form.customModel') },
              ]}
            />
          </Field>
          <Field label={t('settings.agents.form.effort')}>
            <AgentSelect
              label={t('settings.agents.form.effort')}
              value={effort}
              onChange={setEffort}
              items={[
                { value: 'inherit', label: t('settings.agents.form.inherit') },
                ...(hasLegacyEffort ? [{ value: initialEffort, label: initialEffort }] : []),
                ...EFFORTS.map((value) => ({ value, label: value })),
              ]}
            />
          </Field>
        </div>

        {modelChoice === 'custom' && (
          <Input
            label={t('settings.agents.form.customModelId')}
            required
            value={customModel}
            error={fieldErrors.customModel}
            onChange={(event) => setCustomModel(event.target.value)}
          />
        )}

        <Field label={t('settings.agents.form.tools')}>
          <AgentSelect<ToolAccessMode>
            label={t('settings.agents.form.tools')}
            value={toolAccess}
            onChange={setToolAccess}
            items={[
              { value: 'inherit', label: t('settings.agents.form.toolsInherit') },
              { value: 'none', label: t('settings.agents.form.toolsNone') },
              { value: 'custom', label: t('settings.agents.form.toolsCustom') },
            ]}
          />
        </Field>
        <p className="-mt-3 text-xs text-[var(--color-text-tertiary)]">
          {toolAccess === 'inherit'
            ? t('settings.agents.form.toolsInheritHint')
            : toolAccess === 'none'
              ? t('settings.agents.form.toolsNoneHint')
              : t('settings.agents.form.toolsHint')}
        </p>
        {toolAccess === 'custom' && (
          <ToolPicker
            availableTools={availableTools}
            selectedTools={selectedBuiltInTools}
            customTools={customTools}
            error={fieldErrors.tools}
            onSelectedToolsChange={(nextTools) => {
              setSelectedBuiltInTools(nextTools)
              setToolsDirty(true)
            }}
            onCustomToolsChange={(value) => {
              setCustomTools(value)
              setToolsDirty(true)
            }}
          />
        )}

        <Field label={t('settings.agents.form.color')}>
          <AgentSelect
            label={t('settings.agents.form.color')}
            value={color}
            onChange={setColor}
            items={[
              { value: '', label: t('settings.agents.form.noColor') },
              ...Object.keys(AGENT_COLORS).map((value) => ({
                value,
                label: value,
                icon: <span className="h-3 w-3 rounded-full" style={{ backgroundColor: AGENT_COLORS[value] }} />,
              })),
            ]}
          />
        </Field>

        {submitError && (
          <div role="alert" className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 px-3 py-2 text-sm text-[var(--color-error)]">
            {submitError}
          </div>
        )}
      </div>
    </Modal>
  )
}

function ToolPicker({
  availableTools,
  selectedTools,
  customTools,
  error,
  onSelectedToolsChange,
  onCustomToolsChange,
}: {
  availableTools: string[]
  selectedTools: string[]
  customTools: string
  error?: string
  onSelectedToolsChange: (tools: string[]) => void
  onCustomToolsChange: (value: string) => void
}) {
  const t = useTranslation()
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleTools = availableTools.filter((tool) => {
    if (!normalizedQuery) return true
    const metadata = TOOL_METADATA[tool]
    const description = t(metadata?.description ?? 'settings.agents.form.toolDescription.generic')
    const category = t(`settings.agents.form.toolCategory.${metadata?.category ?? 'other'}`)
    return `${tool} ${description} ${category}`.toLowerCase().includes(normalizedQuery)
  })
  const groupedTools = TOOL_CATEGORY_ORDER.map((category) => ({
    category,
    tools: visibleTools.filter(tool => (TOOL_METADATA[tool]?.category ?? 'other') === category),
  })).filter(group => group.tools.length > 0)

  const toggleTool = (tool: string) => {
    onSelectedToolsChange(
      selectedTools.includes(tool)
        ? selectedTools.filter(selectedTool => selectedTool !== tool)
        : [...selectedTools, tool],
    )
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('settings.agents.form.builtInTools')}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
            {t('settings.agents.form.builtInToolsHint')}
          </p>
        </div>
        <span className="rounded-full bg-[var(--color-primary-fixed)] px-2.5 py-1 text-xs font-medium text-[var(--color-brand)]">
          {t('settings.agents.form.toolsSelectedCount', { count: selectedTools.length })}
        </span>
      </div>

      {availableTools.length > 0 ? (
        <>
          <label className="relative mb-3 block">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
            <input
              type="search"
              aria-label={t('settings.agents.form.toolsSearch')}
              value={query}
              placeholder={t('settings.agents.form.toolsSearchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:ring-2 focus:ring-[var(--color-brand)]/15"
            />
          </label>
          <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
            {groupedTools.map(({ category, tools }) => (
              <section key={category} aria-label={t(`settings.agents.form.toolCategory.${category}`)}>
                <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  {t(`settings.agents.form.toolCategory.${category}`)}
                </h4>
                <div className="grid gap-2 sm:grid-cols-2">
                  {tools.map((tool) => {
                    const selected = selectedTools.includes(tool)
                    const description = t(TOOL_METADATA[tool]?.description ?? 'settings.agents.form.toolDescription.generic')
                    return (
                      <button
                        key={tool}
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={`${tool} — ${description}`}
                        onClick={() => toggleTool(tool)}
                        className={`flex min-h-14 items-start gap-2.5 rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-colors ${
                          selected
                            ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-selected)]'
                            : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                        }`}
                      >
                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          selected
                            ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                            : 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
                        }`}>
                          {selected && <Check size={12} strokeWidth={3} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block font-mono text-xs font-semibold text-[var(--color-text-primary)]">{tool}</span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-[var(--color-text-tertiary)]">{description}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
            {groupedTools.length === 0 && (
              <p className="py-5 text-center text-xs text-[var(--color-text-tertiary)]">
                {t('settings.agents.form.toolsNoResults')}
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-xs text-[var(--color-text-tertiary)]">
          {t('settings.agents.form.toolsUnavailable')}
        </p>
      )}

      <div className="mt-3 border-t border-[var(--color-border)] pt-3">
        <Input
          label={t('settings.agents.form.toolsCustomLabel')}
          value={customTools}
          error={error}
          placeholder={t('settings.agents.form.toolsPlaceholder')}
          onChange={(event) => onCustomToolsChange(event.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
          {t('settings.agents.form.toolsCustomHint')}
        </p>
      </div>
    </div>
  )
}

function AgentDeleteDialog({
  agent,
  cwd,
  sessionId,
  onClose,
}: {
  agent: AgentDefinition | null
  cwd?: string
  sessionId?: string
  onClose: () => void
}) {
  const t = useTranslation()
  const deleteAgent = useAgentStore((state) => state.deleteAgent)
  const isMutating = useAgentStore((state) => state.isMutating)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const scope = agent ? getEditableScope(agent) : null

  useEffect(() => {
    setDeleteError(null)
  }, [agent])

  const handleDelete = async () => {
    if (!agent || !scope) return
    setDeleteError(null)
    try {
      await deleteAgent(agent.agentType, scope, cwd, agent.target, sessionId)
      onClose()
    } catch {
      setDeleteError(t('settings.agents.deleteError'))
    }
  }

  return (
    <ConfirmDialog
      open={Boolean(agent)}
      onClose={isMutating ? () => {} : onClose}
      onConfirm={handleDelete}
      title={t('settings.agents.deleteTitle')}
      body={(
        <div className="space-y-3">
          <p>{t('settings.agents.deleteBody', { name: agent?.agentType || '' })}</p>
          {agent?.target && (
            <p className="break-all font-mono text-xs text-[var(--color-text-tertiary)]">
              {t('settings.agents.deleteTarget', { target: agent.target })}
            </p>
          )}
          {deleteError && <p role="alert" className="text-sm text-[var(--color-error)]">{deleteError}</p>}
        </div>
      )}
      confirmLabel={t('settings.agents.deleteConfirm')}
      cancelLabel={t('common.cancel')}
      loading={isMutating}
    />
  )
}

function isEditableAgent(agent: AgentDefinition) {
  return agent.editable === true && getEditableScope(agent) !== null
}

function getEditableScope(agent: AgentDefinition): AgentScope | null {
  if (agent.source === 'userSettings') return 'user'
  if (agent.source === 'projectSettings') return 'project'
  return null
}

function parseTools(value: string) {
  const parsed: string[] = []
  let current = ''
  let parenDepth = 0

  const pushCurrent = () => {
    const tool = current.trim()
    if (tool) parsed.push(tool)
    current = ''
  }

  for (const char of value) {
    if (char === '(') {
      parenDepth += 1
      current += char
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      current += char
    } else if ((char === ',' || char === ' ') && parenDepth === 0) {
      pushCurrent()
    } else {
      current += char
    }
  }
  pushCurrent()

  return [...new Set(parsed)]
}

function getAgentDotColor(color?: string) {
  return color && AGENT_COLORS[color] ? AGENT_COLORS[color] : 'var(--color-text-tertiary)'
}

function getAgentSourceIcon(source: AgentSource) {
  const iconProps = { size: 16 }
  switch (source) {
    case 'userSettings': return <User {...iconProps} />
    case 'projectSettings': return <Folder {...iconProps} />
    case 'localSettings': return <LockKeyhole {...iconProps} />
    case 'policySettings': return <Shield {...iconProps} />
    case 'plugin': return <Boxes {...iconProps} />
    case 'flagSettings': return <Terminal {...iconProps} />
    case 'built-in': return <Box {...iconProps} />
  }
}

function getAgentSourceAccentClass(source: AgentSource) {
  switch (source) {
    case 'userSettings': return 'bg-[var(--color-primary-fixed)] text-[var(--color-brand)]'
    case 'projectSettings': return 'bg-[var(--color-success-container)] text-[var(--color-success)]'
    case 'localSettings': return 'bg-[var(--color-info-container)] text-[var(--color-info)]'
    case 'policySettings': return 'bg-[var(--color-warning-container)] text-[var(--color-warning)]'
    case 'plugin': return 'bg-[var(--color-warning-container)] text-[var(--color-warning)]'
    case 'flagSettings': return 'bg-[var(--color-error)]/10 text-[var(--color-error)]'
    case 'built-in': return 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]'
  }
}

function AgentSelect<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string
  items: Array<{ value: T; label: string; icon?: ReactNode }>
  value: T
  onChange: (value: T) => void
}) {
  const selected = items.find((item) => item.value === value) ?? items[0]
  return (
    <Dropdown<T>
      items={items}
      value={value}
      onChange={onChange}
      width="100%"
      maxHeight={280}
      placement="top"
      className="block w-full"
      trigger={(
        <button
          type="button"
          aria-label={label}
          className="flex h-10 w-full items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-left text-sm text-[var(--color-text-primary)] outline-none transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-container-low)] focus-visible:border-[var(--color-border-focus)] focus-visible:shadow-[var(--shadow-focus-ring)]"
        >
          {selected?.icon && <span className="shrink-0">{selected.icon}</span>}
          <span className="min-w-0 flex-1 truncate">{selected?.label ?? value}</span>
          <ChevronDown size={16} className="shrink-0 text-[var(--color-text-tertiary)]" />
        </button>
      )}
    />
  )
}

function Field({ label, error, required, children }: { label: string; error?: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-[var(--color-text-primary)]">
        {label}{required && <span className="ml-0.5 text-[var(--color-error)]">*</span>}
      </span>
      {children}
      {error && <p className="text-xs text-[var(--color-error)]">{error}</p>}
    </div>
  )
}

function MetaPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
      {children}
    </span>
  )
}

function SummaryCard({ label, value, icon, className = '' }: { label: string; value: string; icon: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 ${className}`}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">{icon}<span className="truncate">{label}</span></div>
      <div className="mt-2 truncate text-lg font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  )
}

function DetailStat({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">{icon}<span>{label}</span></div>
      <div className="mt-2 break-all text-base font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  )
}

const textAreaClassName = 'min-h-32 resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]'
