import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Bot,
  Box,
  Boxes,
  Bolt,
  Check,
  CircleAlert,
  Folder,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  Terminal,
  Trash2,
  User,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import type { ModelInfo } from '../../types/settings'
import type {
  AgentDefinition,
  AgentMutationInput,
  AgentScope,
  AgentSource,
} from '../../api/agents'
import { useAgentStore } from '../../stores/agentStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getSessionBrowsablePath } from '../../lib/sessionWorkspace'
import { useUIStore } from '../../stores/uiStore'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { DirectoryPicker } from '@/components/composite/DirectoryPicker'
import { IconButton } from '@/components/ui/IconButton'
import { FIELD_BASE_CLASSES, Input, fieldStateClasses } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { SearchField } from '@/components/ui/SearchField'
import { SelectField } from '@/components/ui/SelectField'
import {
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsStat,
} from '@/components/settings/SettingsSection'
import { ModelSelector } from '@/components/controls/ModelSelector'
import { cx } from '@/lib/cx'

/**
 * The colour names an agent file may declare (`color: blue`), rendered as
 * theme tokens so the bot glyph follows the active palette instead of sitting
 * on the same Tailwind-500 hex under all six themes.
 *
 * The hue names have no status meaning, so they borrow the terminal's ANSI
 * ramp — the one themed set of plain hues — rather than the status pairs. The
 * two hues it lacks fall back to the nearest themed accents: orange to the
 * warning amber, cyan to the teal tertiary.
 */
const AGENT_COLORS: Record<string, string> = {
  red: 'var(--color-terminal-ansi-red)',
  orange: 'var(--color-warning)',
  yellow: 'var(--color-terminal-ansi-yellow)',
  green: 'var(--color-terminal-ansi-green)',
  blue: 'var(--color-terminal-ansi-blue)',
  purple: 'var(--color-terminal-ansi-magenta)',
  pink: 'var(--color-terminal-ansi-bright-magenta)',
  cyan: 'var(--color-tertiary)',
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
/**
 * "Use whatever this build ships" in the built-in override modal, submitted as
 * `null`. Distinct from `inherit`, which is itself a persistable choice.
 */
const DEFAULT_CHOICE = '__default__'
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
  const [overrideTarget, setOverrideTarget] = useState<AgentDefinition | null>(null)

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = getSessionBrowsablePath(activeSession)
  const [agentContextPath, setAgentContextPath] = useState<string | undefined>(currentWorkDir)
  const contextSessionId = (
    activeSession && getSessionBrowsablePath(activeSession) === agentContextPath
      ? activeSession
      : sessions.find(
          (session) => getSessionBrowsablePath(session) === agentContextPath,
        )
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
          className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] bg-[var(--color-warning-container)] px-4 py-2.5"
          role="status"
        >
          <div className="flex min-w-0 items-start gap-2">
            <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-on-warning-container)]" />
            <p className="min-w-0 text-[13px] font-medium leading-5 text-[var(--color-on-warning-container)]">
              {t('settings.agents.refreshWarning')}
            </p>
          </div>
          <Button
            variant="secondary"
            size="base"
            icon={<RefreshCw size={14} strokeWidth={1.75} />}
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
          onOverride={() => setOverrideTarget(selectedAgent)}
        />
      ) : (
        <>
          <SettingsPageHeader
            title={t('settings.tab.agents')}
            description={t('settings.agents.description')}
            action={(
              <Button
                variant="primary"
                size="base"
                icon={<Plus size={14} strokeWidth={1.75} />}
                onClick={() => setFormState({ mode: 'create' })}
              >
                {t('settings.agents.create')}
              </Button>
            )}
          />

          {isLoading && allAgents.length === 0 ? (
            <div className="mt-7">
              <LoadingState label={t('common.loading')} labelHidden size="md" />
            </div>
          ) : error ? (
            <div className="mt-7">
              <ErrorState
                title={t('settings.agents.loadError')}
                onRetry={() => void fetchAgents(agentContextPath)}
                retryLabel={t('common.retry')}
                size="lg"
              />
            </div>
          ) : allAgents.length === 0 ? (
            <div className="mt-7">
              <EmptyState
                icon={<Bot size={20} strokeWidth={1.75} />}
                title={t('settings.agents.empty')}
                description={t('settings.agents.emptyHint')}
                size="md"
              />
            </div>
          ) : (
            <>
              <div className="mt-6 grid min-w-0 grid-cols-3 gap-3">
                <SettingsStat label={t('settings.agents.summary.totalAgents')} value={String(allAgents.length)} />
                <SettingsStat label={t('settings.agents.summary.activeAgents')} value={String(activeAgents.length)} />
                <SettingsStat label={t('settings.agents.summary.sources')} value={String(sourceCount)} />
              </div>

              {AGENT_SOURCE_ORDER.map((source) => {
                const group = groupedAgents[source]
                if (!group?.length) return null
                const sourceLabel = t(`settings.agents.source.${source}`)
                return (
                  <SettingsSection
                    key={source}
                    title={(
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="text-[var(--color-text-tertiary)]">{getAgentSourceIcon(source)}</span>
                        <span>{sourceLabel}</span>
                        <span className="font-normal tabular-nums text-[var(--color-text-tertiary)]">{group.length}</span>
                      </span>
                    )}
                  >
                    <SettingsGroup>
                      {group.map((agent, index) => (
                        // A row is a div, not a button: the actions on the
                        // right have to be siblings of the primary control,
                        // never nested inside it.
                        <div
                          key={`${agent.source}-${agent.agentType}-${agent.target ?? agent.baseDir ?? index}`}
                          className="group flex min-h-[52px] items-start gap-2 px-4 py-3 transition-colors duration-150 first:rounded-t-[var(--radius-lg)] last:rounded-b-[var(--radius-lg)] hover:bg-[var(--color-surface-hover)]"
                        >
                          <button
                            type="button"
                            onClick={() => selectAgent(agent, 'agents')}
                            className="flex min-w-0 flex-1 items-start gap-3 rounded-[var(--radius-sm)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                          >
                            <span
                              aria-hidden="true"
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-container)]"
                            >
                              <Bot size={16} strokeWidth={1.75} style={{ color: getAgentDotColor(agent.color) }} />
                            </span>
                            <span className="block min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="break-all font-mono text-[13px] font-medium text-[var(--color-text-primary)]">{agent.agentType}</span>
                                {agent.modelDisplay && <MetaPill mono>{agent.modelDisplay}</MetaPill>}
                                {agent.effort !== undefined && <MetaPill>{agent.effort}</MetaPill>}
                                <Badge tone={agent.isActive ? 'success' : 'neutral'}>
                                  {agent.isActive ? t('settings.agents.status.active') : t('settings.agents.status.available')}
                                </Badge>
                                {agent.overriddenBy && (
                                  <MetaPill>{t('settings.agents.overriddenBy', { source: t(`settings.agents.source.${agent.overriddenBy}`) })}</MetaPill>
                                )}
                              </span>
                              <span className="mt-1 block break-words text-xs leading-[1.5] text-[var(--color-text-secondary)] [&_.prose]:text-xs [&_.prose]:leading-[1.5] [&_.prose]:text-[var(--color-text-secondary)]">
                                <MarkdownRenderer content={agent.description || t('settings.agents.noDescription')} />
                              </span>
                              <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
                                <span>{agent.tools === undefined
                                  ? t('settings.agents.noTools')
                                  : agent.tools.length === 0
                                    ? t('settings.agents.disabledTools')
                                    : t('settings.agents.toolCount', { count: String(agent.tools.length) })}</span>
                                {(agent.target || agent.baseDir) && <span className="break-all font-mono">{agent.target || agent.baseDir}</span>}
                              </span>
                            </span>
                          </button>
                          <AgentRowActions
                            agent={agent}
                            onEdit={() => setFormState({ mode: 'edit', agent })}
                            onDelete={() => setDeleteTarget(agent)}
                            onOverride={() => setOverrideTarget(agent)}
                          />
                        </div>
                      ))}
                    </SettingsGroup>
                  </SettingsSection>
                )
              })}
            </>
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
      {overrideTarget && (
        <BuiltInAgentOverrideModal
          agent={overrideTarget}
          cwd={agentContextPath}
          sessionId={contextSessionId}
          onClose={() => setOverrideTarget(null)}
        />
      )}
    </div>
  )
}

function AgentDetailView({
  agent,
  onBack,
  onEdit,
  onDelete,
  onOverride,
}: {
  agent: AgentDefinition
  onBack: () => void
  onEdit: () => void
  onDelete: () => void
  onOverride: () => void
}) {
  const t = useTranslation()
  const sourceLabel = t(`settings.agents.source.${agent.source}`)
  const editable = isEditableAgent(agent)
  const inherited = t('settings.agents.detail.inherit')

  const toolSummary = agent.tools === undefined
    ? t('settings.agents.noTools')
    : agent.tools.length === 0
      ? t('settings.agents.disabledTools')
      : t('settings.agents.toolCount', { count: String(agent.tools.length) })

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="base" className="-ml-3" icon={<ArrowLeft size={14} strokeWidth={1.75} />} onClick={onBack}>
          {t('settings.agents.backToList')}
        </Button>
        {editable ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="base" icon={<Pencil size={14} strokeWidth={1.75} />} onClick={onEdit}>
              {t('settings.agents.edit')}
            </Button>
            <Button variant="danger-ghost" size="base" icon={<Trash2 size={14} strokeWidth={1.75} />} onClick={onDelete}>
              {t('settings.agents.delete')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {agent.overridable && (
              <Button variant="secondary" size="base" icon={<Bolt size={14} strokeWidth={1.75} />} onClick={onOverride}>
                {t('settings.agents.override')}
              </Button>
            )}
            {/* Kept alongside the button: the prompt and tools really are fixed,
                and only the model and effort are not. */}
            <Badge tone="neutral" icon={<LockKeyhole size={11} strokeWidth={2} aria-hidden="true" />}>
              {t('settings.agents.readOnly')}
            </Badge>
          </div>
        )}
      </div>

      {/* The agent's own page header: same 22px title as every settings pane. */}
      <header className="mt-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: getAgentDotColor(agent.color) }}
          />
          <h2 className="min-w-0 break-all text-[22px] font-semibold leading-tight tracking-[-0.015em] text-[var(--color-text-primary)]">
            {agent.agentType}
          </h2>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <MetaPill>{sourceLabel}</MetaPill>
          <Badge tone={agent.isActive ? 'success' : 'neutral'}>
            {agent.isActive ? t('settings.agents.status.active') : t('settings.agents.status.available')}
          </Badge>
          {agent.overriddenBy && (
            <MetaPill>{t('settings.agents.overriddenByShort', { source: t(`settings.agents.source.${agent.overriddenBy}`) })}</MetaPill>
          )}
        </div>
        <div className="mt-2 text-[13px] leading-5 text-[var(--color-text-tertiary)] [&_.prose]:text-[13px] [&_.prose]:leading-5 [&_.prose]:text-[var(--color-text-tertiary)]">
          <MarkdownRenderer content={agent.description || t('settings.agents.noDescription')} />
        </div>
      </header>

      <SettingsSection title={t('settings.agents.entryEyebrow')}>
        <SettingsGroup>
          <SettingsRow title={t('settings.agents.detail.configuredModel')} layout="inline">
            <span className="break-all font-mono text-xs text-[var(--color-text-secondary)]">{agent.model || inherited}</span>
          </SettingsRow>
          <SettingsRow
            title={t('settings.agents.detail.configuredEffort')}
            description={t('settings.agents.detail.effortHint')}
            layout="inline"
          >
            <span className="font-mono text-xs text-[var(--color-text-secondary)]">
              {agent.effort === undefined ? inherited : String(agent.effort)}
            </span>
          </SettingsRow>
          <SettingsRow
            title={t('settings.agents.summary.tools')}
            layout="inline"
            footer={agent.tools && agent.tools.length > 0 ? (
              <div role="list" aria-label={t('settings.agents.tools')} className="flex flex-wrap gap-1.5">
                {agent.tools.map((tool) => (
                  <span
                    key={tool}
                    role="listitem"
                    className="inline-flex h-6 items-center rounded-[var(--radius-xs)] bg-[var(--color-surface-container)] px-2 font-mono text-[11px] text-[var(--color-text-secondary)]"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            ) : undefined}
          >
            <span className="text-xs text-[var(--color-text-secondary)]">{toolSummary}</span>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t('settings.agents.systemPrompt')} description={t('settings.agents.promptHint')}>
        <div className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
          <div className="flex min-h-9 items-center border-b border-[var(--color-border)] px-4 py-2">
            <span className="min-w-0 break-all font-mono text-[11px] text-[var(--color-text-tertiary)]">
              {agent.target || agent.baseDir || sourceLabel}
            </span>
          </div>
          {agent.systemPrompt ? (
            <div className="px-6 py-5">
              <MarkdownRenderer content={agent.systemPrompt} variant="document" className="mx-auto max-w-[72ch]" />
            </div>
          ) : (
            <div className="px-6 py-10 text-center text-[13px] text-[var(--color-text-tertiary)]">{t('settings.agents.noSystemPrompt')}</div>
          )}
        </div>
      </SettingsSection>
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
  const [modelChoice, setModelChoice] = useState(initialModel)
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
        ? { model: modelChoice === 'inherit' ? null : modelChoice }
        : modelChoice === 'inherit' ? {} : { model: modelChoice }),
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
              { value: 'user' as const, label: t('settings.agents.form.scopeUser'), icon: <User size={16} strokeWidth={1.75} /> },
              { value: 'project' as const, label: t('settings.agents.form.scopeProject'), icon: <Folder size={16} strokeWidth={1.75} /> },
            ]).map((option) => {
              const selected = scope === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  disabled={mode === 'edit'}
                  onClick={() => setScope(option.value)}
                  // The option-card selection of the spec: terracotta outline
                  // over the faintest terracotta wash, never a filled block.
                  className={cx(
                    'flex h-12 items-center gap-2.5 rounded-[var(--radius-md)] border px-3 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                    selected
                      ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-text-primary)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
                      selected
                        ? 'bg-[var(--color-surface-container-lowest)] text-[var(--color-brand)]'
                        : 'bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]',
                    )}
                  >
                    {option.icon}
                  </span>
                  <span className="text-[13px] font-medium">{option.label}</span>
                </button>
              )
            })}
          </div>
          {scope === 'project' && (
            <div className="mt-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all text-[13px] text-[var(--color-text-secondary)]">
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
            className={cx(
              FIELD_BASE_CLASSES,
              'min-h-32 resize-y px-2.5 py-2 text-[13px] leading-6',
              fieldStateClasses(Boolean(fieldErrors.systemPrompt)),
            )}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.agents.form.model')}>
            <AgentModelSelector
              label={t('settings.agents.form.model')}
              value={modelChoice}
              onChange={setModelChoice}
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

        <p className="-mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.form.modelProviderHint')}
        </p>

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
              })),
            ]}
          />
        </Field>

        {submitError && <ErrorState title={submitError} size="sm" />}
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
    // A sunken well with no border of its own: the tool cards inside carry the
    // only hairline, so the dialog never stacks border inside border.
    <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[13px] font-medium text-[var(--color-text-primary)]">
            {t('settings.agents.form.builtInTools')}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
            {t('settings.agents.form.builtInToolsHint')}
          </p>
        </div>
        <Badge tone="neutral" className="tabular-nums">
          {t('settings.agents.form.toolsSelectedCount', { count: selectedTools.length })}
        </Badge>
      </div>

      {availableTools.length > 0 ? (
        <>
          <SearchField
            value={query}
            onChange={setQuery}
            label={t('settings.agents.form.toolsSearch')}
            // Without this the clear button falls back to the field's own name,
            // so both carry the same accessible label.
            clearLabel={t('common.clearSearch')}
            placeholder={t('settings.agents.form.toolsSearchPlaceholder')}
            size="md"
            containerClassName="mb-3"
          />
          <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
            {groupedTools.map(({ category, tools }) => (
              <section key={category} aria-label={t(`settings.agents.form.toolCategory.${category}`)}>
                <h4 className="mb-1.5 text-xs font-semibold text-[var(--color-text-tertiary)]">
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
                        className={cx(
                          'flex min-h-14 items-start gap-2.5 rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
                          selected
                            ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]'
                            : 'border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] hover:bg-[var(--color-surface-hover)]',
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cx(
                            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-xs)] border',
                            selected
                              ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-[var(--color-on-primary)]'
                              : 'border-[var(--color-border-strong)] bg-[var(--color-surface-container-lowest)]',
                          )}
                        >
                          {selected && <Check size={12} strokeWidth={2.5} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block font-mono text-xs font-medium text-[var(--color-text-primary)]">{tool}</span>
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
        <EmptyState description={t('settings.agents.form.toolsUnavailable')} variant="dashed" size="sm" />
      )}

      <div className="mt-3 border-t border-[var(--color-border-separator)] pt-3">
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

/**
 * Model/effort editor for a built-in agent.
 *
 * Deliberately not `AgentFormModal` with a flag. That component exists to build
 * an `AgentMutationInput` whose name, description and system prompt are all
 * required, and none of those apply here; threading a variant through its
 * render branches and its payload-construction chain would put the riskiest
 * code in this file on a second, unrelated path.
 */
function BuiltInAgentOverrideModal({
  agent,
  cwd,
  sessionId,
  onClose,
}: {
  agent: AgentDefinition
  cwd?: string
  sessionId?: string
  onClose: () => void
}) {
  const t = useTranslation()
  const setAgentOverride = useAgentStore((state) => state.setAgentOverride)
  const clearAgentOverride = useAgentStore((state) => state.clearAgentOverride)
  const isMutating = useAgentStore((state) => state.isMutating)

  const defaultModel = agent.defaults?.model
  const defaultEffort = agent.defaults?.effort
  const overrideSource = agent.override?.source
  // A managed or project-level override cannot be edited from the user file
  // this modal writes to, so saying so beats a write that silently loses.
  const isManaged = overrideSource !== undefined && overrideSource !== 'userSettings'

  const initialModel = agent.override?.model
  const initialEffort = agent.override?.effort
  const [modelChoice, setModelChoice] = useState(
    initialModel ?? DEFAULT_CHOICE,
  )
  const [effort, setEffort] = useState(
    initialEffort === undefined ? DEFAULT_CHOICE : String(initialEffort),
  )
  const [submitError, setSubmitError] = useState<string | null>(null)

  const describeDefault = (value: string | number | undefined) =>
    value === undefined
      ? t('settings.agents.overrideDefaultNone')
      : t('settings.agents.overrideDefault', { value: String(value) })

  const handleSave = async () => {
    setSubmitError(null)
    try {
      await setAgentOverride(
        agent.agentType,
        {
          ...(cwd ? { cwd } : {}),
          // `null` clears the override so the shipped default applies again.
          // Never send the default's literal value: that would freeze today's
          // default into the user's settings file forever.
          model:
            modelChoice === DEFAULT_CHOICE
              ? null
              : modelChoice,
          effort: effort === DEFAULT_CHOICE ? null : effort,
        },
        sessionId,
      )
      onClose()
    } catch {
      setSubmitError(t('settings.agents.overrideSaveError'))
    }
  }

  const handleReset = async () => {
    setSubmitError(null)
    try {
      await clearAgentOverride(agent.agentType, cwd, sessionId)
      onClose()
    } catch {
      setSubmitError(t('settings.agents.overrideResetError'))
    }
  }

  return (
    <Modal
      open
      onClose={isMutating ? () => {} : onClose}
      title={t('settings.agents.overrideTitle')}
      width={520}
      footer={(
        <>
          {agent.override && !isManaged && (
            <Button variant="ghost" onClick={() => void handleReset()} disabled={isMutating}>
              {t('settings.agents.overrideReset')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={isMutating}>{t('common.cancel')}</Button>
          <Button onClick={() => void handleSave()} disabled={isMutating || isManaged}>
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all font-mono text-[13px] font-medium text-[var(--color-text-primary)]">
            {agent.agentType}
          </span>
          <MetaPill>{t('settings.agents.source.built-in')}</MetaPill>
          {agent.override && <MetaPill>{t('settings.agents.overrideBadge')}</MetaPill>}
        </div>

        {agent.overriddenBy && (
          // Editing a built-in that a same-named user agent shadows would look
          // like it worked and change nothing at spawn time.
          <p role="status" className="rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-on-warning-container)]">
            {t('settings.agents.overrideShadowed', {
              source: t(`settings.agents.source.${agent.overriddenBy}`),
            })}
          </p>
        )}
        {isManaged && (
          <p role="status" className="rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)]">
            {t('settings.agents.overrideManaged', {
              source: t(`settings.agents.source.${overrideSource}`),
            })}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.agents.form.model')}>
            <AgentModelSelector
              label={t('settings.agents.form.model')}
              value={modelChoice}
              onChange={setModelChoice}
              disabled={isManaged}
              defaultLabel={describeDefault(defaultModel)}
            />
          </Field>
          <Field label={t('settings.agents.form.effort')}>
            <AgentSelect
              label={t('settings.agents.form.effort')}
              value={effort}
              onChange={setEffort}
              disabled={isManaged}
              items={[
                // No "inherit" entry: effort has no such value, omitting it is
                // what inherits.
                { value: DEFAULT_CHOICE, label: describeDefault(defaultEffort) },
                ...EFFORTS.map((value) => ({ value, label: value })),
              ]}
            />
          </Field>
        </div>

        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.overrideHint')}
        </p>
        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.form.modelProviderHint')}
        </p>
        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.overrideScopeHint')}
        </p>
        {submitError && <p role="alert" className="text-[13px] text-[var(--color-error)]">{submitError}</p>}
      </div>
    </Modal>
  )
}

/**
 * The per-row actions, rendered as a sibling of the row's primary button.
 *
 * Hidden until the row is hovered, but `focus-within` is not optional: without
 * it a keyboard user tabs onto a control they cannot see. The fade lives on
 * this wrapper rather than on the buttons because IconButton already sets
 * `transition-colors`, and a second transition utility on the same element
 * resolves by stylesheet order instead of by intent.
 */
function AgentRowActions({
  agent,
  onEdit,
  onDelete,
  onOverride,
}: {
  agent: AgentDefinition
  onEdit: () => void
  onDelete: () => void
  onOverride: () => void
}) {
  const t = useTranslation()
  const editable = isEditableAgent(agent)
  const overridable = agent.overridable === true

  if (!editable && !overridable) return null

  return (
    <span
      // Marked for the touch stylesheet: hover-only affordances are
      // permanently invisible on a touchscreen.
      data-agent-row-actions
      className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
    >
      {editable ? (
        <>
          <IconButton
            size="sm"
            tone="muted"
            icon={<Pencil size={14} strokeWidth={1.75} />}
            label={t('settings.agents.rowEdit', { name: agent.agentType })}
            onClick={onEdit}
          />
          <IconButton
            size="sm"
            tone="muted"
            // A delete icon that sits red at rest reads as an error state.
            hoverTone="danger"
            icon={<Trash2 size={14} strokeWidth={1.75} />}
            label={t('settings.agents.rowDelete', { name: agent.agentType })}
            onClick={onDelete}
          />
        </>
      ) : (
        // Built-ins get model/effort only — their file is never rewritten, so
        // there is deliberately no delete here.
        <IconButton
          size="sm"
          tone="muted"
          icon={<Bolt size={14} strokeWidth={1.75} />}
          label={t('settings.agents.rowOverride', { name: agent.agentType })}
          onClick={onOverride}
        />
      )}
    </span>
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

/** The 14px glyph beside a source section's label. */
function getAgentSourceIcon(source: AgentSource) {
  const iconProps = { size: 14, strokeWidth: 1.75 }
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

function AgentModelSelector({
  label,
  value,
  onChange,
  disabled,
  defaultLabel,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  defaultLabel?: string
}) {
  const t = useTranslation()
  const availableModels = useSettingsStore((state) => state.availableModels)
  const models = useMemo(() => {
    const choices: ModelInfo[] = []
    const seen = new Set<string>()
    const add = (model: ModelInfo) => {
      if (seen.has(model.id)) return
      seen.add(model.id)
      choices.push(model)
    }

    if (defaultLabel) {
      add({
        id: DEFAULT_CHOICE,
        name: defaultLabel,
        description: t('settings.agents.form.modelDefaultDescription'),
        context: '',
      })
    }
    add({
      id: 'inherit',
      name: t('settings.agents.form.inherit'),
      description: t('settings.agents.form.modelInheritDescription'),
      context: '',
    })
    for (const alias of BUILT_IN_MODELS) {
      add({
        id: alias,
        name: alias,
        description: t('settings.agents.form.modelAliasDescription'),
        context: '',
      })
    }

    if (!seen.has(value) && value) {
      add({
        id: value,
        name: value,
        description: t('settings.agents.form.modelUnavailableDescription'),
        context: '',
      })
    }
    availableModels.forEach(add)
    return choices
  }, [availableModels, defaultLabel, t, value])

  return (
    <ModelSelector
      value={value}
      onChange={onChange}
      models={models}
      ariaLabel={label}
      appearance="field"
      disabled={disabled}
      fluid
    />
  )
}

function AgentSelect<T extends string>({
  label,
  items,
  value,
  onChange,
  disabled,
}: {
  label: string
  items: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <SelectField<T>
      label={label}
      labelHidden
      options={items.map(({ value: optionValue, label: optionLabel }) => ({
        value: optionValue,
        label: optionLabel,
      }))}
      value={value}
      onChange={onChange}
      disabled={disabled}
      size="lg"
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

/**
 * The agent metadata chip: an 11px neutral pill in sentence case. `mono` is for
 * model ids, which are identifiers rather than words.
 */
function MetaPill({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <Badge tone="neutral" mono={mono}>
      {children}
    </Badge>
  )
}
