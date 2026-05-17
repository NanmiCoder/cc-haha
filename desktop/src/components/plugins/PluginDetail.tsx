import { useMemo, useState, type ReactNode } from 'react'
import { usePluginStore } from '../../stores/pluginStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { Button } from '../shared/Button'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import type { PluginCapabilityKey } from '../../types/plugin'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useSkillStore } from '../../stores/skillStore'
import { useAgentStore } from '../../stores/agentStore'
import { useMcpStore } from '../../stores/mcpStore'

const CAPABILITY_ORDER: PluginCapabilityKey[] = [
  'lspServers',
]

export function PluginDetail() {
  const {
    selectedPlugin,
    isDetailLoading,
    isApplying,
    clearSelection,
    enablePlugin,
    disablePlugin,
    updatePlugin,
    uninstallPlugin,
    reloadPlugins,
  } = usePluginStore()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const addToast = useUIStore((s) => s.addToast)
  const fetchSkillDetail = useSkillStore((s) => s.fetchSkillDetail)
  const fetchAgents = useAgentStore((s) => s.fetchAgents)
  const selectAgent = useAgentStore((s) => s.selectAgent)
  const fetchServers = useMcpStore((s) => s.fetchServers)
  const selectServer = useMcpStore((s) => s.selectServer)
  const t = useTranslation()
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [showUninstallDialog, setShowUninstallDialog] = useState(false)

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = activeSession?.workDir || undefined

  const otherCapabilityItems = useMemo(
    () =>
      CAPABILITY_ORDER.map((key) => ({
        key,
        items: selectedPlugin?.capabilities[key] ?? [],
      })),
    [selectedPlugin],
  )

  if (isDetailLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin w-5 h-5 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!selectedPlugin) return null

  const canMutate = selectedPlugin.scope !== 'managed' && selectedPlugin.scope !== 'builtin'
  const canNavigateSharedCapabilities = selectedPlugin.enabled

  const runAction = async (key: string, fn: () => Promise<string>) => {
    setActionKey(key)
    try {
      const message = await fn()
      addToast({ type: 'success', message })
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setActionKey(null)
    }
  }

  const handleReload = async () => {
    setActionKey('reload')
    try {
      const summary = await reloadPlugins(currentWorkDir, activeSessionId || undefined)
      addToast({
        type: summary.errors > 0 ? 'warning' : 'success',
        message: t('settings.plugins.reloadToast', {
          enabled: String(summary.enabled),
          skills: String(summary.skills),
          errors: String(summary.errors),
        }),
      })
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setActionKey(null)
    }
  }

  const openSettingsTab = (tab: 'skills' | 'agents' | 'mcp') => {
    useUIStore.getState().setPendingSettingsTab(tab)
    useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
  }

  const handleOpenSkill = async (skillName: string) => {
    if (!canNavigateSharedCapabilities) {
      addToast({
        type: 'warning',
        message: t('settings.plugins.sharedNavigationDisabled'),
      })
      return
    }
    openSettingsTab('skills')
    await fetchSkillDetail('plugin', skillName, currentWorkDir, 'plugins')

    const { selectedSkill, error } = useSkillStore.getState()
    if (!selectedSkill && error) {
      addToast({ type: 'error', message: error })
    }
  }

  const handleOpenAgent = async (agentType: string) => {
    if (!canNavigateSharedCapabilities) {
      addToast({
        type: 'warning',
        message: t('settings.plugins.sharedNavigationDisabled'),
      })
      return
    }
    openSettingsTab('agents')
    await fetchAgents(currentWorkDir)

    const state = useAgentStore.getState()
    const agent = state.allAgents.find((entry) => entry.agentType === agentType)
    if (!agent) {
      addToast({
        type: 'error',
        message: `Unable to locate agent: ${agentType}`,
      })
      return
    }

    selectAgent(agent, 'plugins')
  }

  const handleOpenMcpServer = async (serverName: string) => {
    if (!canNavigateSharedCapabilities) {
      addToast({
        type: 'warning',
        message: t('settings.plugins.sharedNavigationDisabled'),
      })
      return
    }
    openSettingsTab('mcp')
    await fetchServers(undefined, currentWorkDir)

    const state = useMcpStore.getState()
    const server = state.servers.find((entry) => entry.name === serverName)
    if (!server) {
      addToast({
        type: 'error',
        message: `Unable to locate MCP server: ${serverName}`,
      })
      return
    }

    selectServer(server)
  }

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <div>
        <button
          onClick={clearSelection}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          {t('settings.plugins.back')}
        </button>
      </div>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] overflow-hidden">
        <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.9fr)] lg:items-start">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)] mb-2">
              {t('settings.plugins.entryEyebrow')}
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <h3 className="text-[22px] font-semibold leading-tight text-[var(--color-text-primary)] break-all">
                {selectedPlugin.name}
              </h3>
              <StatusPill enabled={selectedPlugin.enabled} hasErrors={selectedPlugin.hasErrors} />
              <MetaPill>{t(`settings.plugins.scope.${selectedPlugin.scope}`)}</MetaPill>
              <MetaPill>{selectedPlugin.marketplace}</MetaPill>
              {selectedPlugin.version && <MetaPill>v{selectedPlugin.version}</MetaPill>}
            </div>
            <p className="max-w-4xl text-sm leading-6 text-[var(--color-text-secondary)]">
              {selectedPlugin.description || t('settings.plugins.noDescription')}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-[var(--color-text-tertiary)]">
              {selectedPlugin.authorName && (
                <span>{t('settings.plugins.author', { value: selectedPlugin.authorName })}</span>
              )}
              {selectedPlugin.projectPath && (
                <span>{t('settings.plugins.projectPath', { value: selectedPlugin.projectPath })}</span>
              )}
              {selectedPlugin.installPath && (
                <span>{t('settings.plugins.installPath', { value: selectedPlugin.installPath })}</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2">
            <DetailStat
              label={t('settings.plugins.summary.skills')}
              value={String(selectedPlugin.componentCounts.skills)}
              icon="auto_awesome"
            />
            <DetailStat
              label={t('settings.plugins.summary.agents')}
              value={String(selectedPlugin.componentCounts.agents)}
              icon="smart_toy"
            />
            <DetailStat
              label={t('settings.plugins.summary.mcp')}
              value={String(selectedPlugin.componentCounts.mcpServers)}
              icon="hub"
            />
            <DetailStat
              label={t('settings.plugins.summary.hooks')}
              value={String(selectedPlugin.componentCounts.hooks)}
              icon="bolt"
            />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {canMutate && (
            selectedPlugin.enabled ? (
              <Button
                variant="secondary"
                size="sm"
                loading={isApplying && actionKey === 'disable'}
                onClick={() => void runAction('disable', () => disablePlugin(selectedPlugin.id, selectedPlugin.scope, currentWorkDir, activeSessionId || undefined))}
              >
                {t('settings.plugins.disable')}
              </Button>
            ) : (
              <Button
                size="sm"
                loading={isApplying && actionKey === 'enable'}
                onClick={() => void runAction('enable', () => enablePlugin(selectedPlugin.id, selectedPlugin.scope, currentWorkDir, activeSessionId || undefined))}
              >
                {t('settings.plugins.enable')}
              </Button>
            )
          )}

          {canMutate && (
            <Button
              variant="secondary"
              size="sm"
              loading={isApplying && actionKey === 'update'}
              onClick={() => void runAction('update', () => updatePlugin(selectedPlugin.id, selectedPlugin.scope, currentWorkDir, activeSessionId || undefined))}
            >
              {t('settings.plugins.update')}
            </Button>
          )}

          <Button
            variant="secondary"
            size="sm"
            loading={isApplying && actionKey === 'reload'}
            onClick={() => void handleReload()}
          >
            {t('settings.plugins.apply')}
          </Button>

          {canMutate && (
            <Button
              variant="danger"
              size="sm"
              loading={isApplying && actionKey === 'uninstall'}
              onClick={() => {
                setShowUninstallDialog(true)
              }}
            >
              {t('settings.plugins.uninstall')}
            </Button>
          )}
        </div>

        {!canMutate && (
          <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">
            {selectedPlugin.scope === 'managed'
              ? t('settings.plugins.managedHint')
              : t('settings.plugins.builtinHint')}
          </p>
        )}

        <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">
          {t('settings.plugins.applyHint')}
        </p>
      </section>

      {selectedPlugin.errors.length > 0 && (
        <section className="rounded-2xl border border-[var(--color-error)]/20 bg-[var(--color-error)]/6 px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-[18px] text-[var(--color-error)]">
              error
            </span>
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {t('settings.plugins.errorsTitle')}
            </h4>
          </div>
          <div className="flex flex-col gap-2">
            {selectedPlugin.errors.map((error) => (
              <div
                key={error}
                className="rounded-xl border border-[var(--color-error)]/15 bg-[var(--color-surface)] px-3 py-3 text-sm text-[var(--color-text-secondary)]"
              >
                {error}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('settings.plugins.capabilitiesTitle')}
          </h4>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
            {t('settings.plugins.capabilitiesHint')}
          </p>
        </div>
        <div className="flex flex-col gap-4 p-4">
          <CapabilityPreviewSection
            title={t('settings.plugins.capabilityLabel.skills')}
            count={selectedPlugin.skillEntries.length}
            emptyLabel={t('settings.plugins.capabilityEmpty')}
            hint={!canNavigateSharedCapabilities ? t('settings.plugins.sharedNavigationDisabled') : undefined}
          >
            {selectedPlugin.skillEntries.length > 0 ? (
              <div className="grid gap-3 xl:grid-cols-2">
                {selectedPlugin.skillEntries.map((skill) => (
                  <SkillPreviewCard
                    key={skill.name}
                    name={skill.displayName || skill.name}
                    rawName={skill.displayName ? skill.name : undefined}
                    description={skill.description}
                    version={skill.version}
                    onClick={() => void handleOpenSkill(skill.name)}
                    disabled={!canNavigateSharedCapabilities}
                  />
                ))}
              </div>
            ) : null}
          </CapabilityPreviewSection>

          <CapabilityPreviewSection
            title={t('settings.plugins.capabilityLabel.mcpServers')}
            count={selectedPlugin.mcpServerEntries.length}
            emptyLabel={t('settings.plugins.capabilityEmpty')}
            hint={!canNavigateSharedCapabilities ? t('settings.plugins.sharedNavigationDisabled') : undefined}
          >
            {selectedPlugin.mcpServerEntries.length > 0 ? (
              <div className="grid gap-3 xl:grid-cols-2">
                {selectedPlugin.mcpServerEntries.map((server) => (
                  <McpPreviewCard
                    key={server.name}
                    name={server.displayName || server.name}
                    transport={server.transport}
                    summary={server.summary}
                    onClick={() => void handleOpenMcpServer(server.name)}
                    disabled={!canNavigateSharedCapabilities}
                  />
                ))}
              </div>
            ) : null}
          </CapabilityPreviewSection>

          <CapabilityPreviewSection
            title={t('settings.plugins.capabilityLabel.commands')}
            count={selectedPlugin.commandEntries.length}
            emptyLabel={t('settings.plugins.capabilityEmpty')}
          >
            {selectedPlugin.commandEntries.length > 0 ? (
              <div className="grid gap-3 xl:grid-cols-2">
                {selectedPlugin.commandEntries.map((command) => (
                  <CommandPreviewCard
                    key={command.name}
                    name={command.name}
                    description={command.description}
                  />
                ))}
              </div>
            ) : null}
          </CapabilityPreviewSection>

          <CapabilityPreviewSection
            title={t('settings.plugins.capabilityLabel.agents')}
            count={selectedPlugin.agentEntries.length}
            emptyLabel={t('settings.plugins.capabilityEmpty')}
            hint={!canNavigateSharedCapabilities ? t('settings.plugins.sharedNavigationDisabled') : undefined}
          >
            {selectedPlugin.agentEntries.length > 0 ? (
              <div className="grid gap-3 xl:grid-cols-2">
                {selectedPlugin.agentEntries.map((agent) => (
                  <AgentPreviewCard
                    key={agent.name}
                    name={agent.displayName || agent.name}
                    description={agent.description}
                    onClick={() => void handleOpenAgent(agent.name)}
                    disabled={!canNavigateSharedCapabilities}
                  />
                ))}
              </div>
            ) : null}
          </CapabilityPreviewSection>

          <CapabilityPreviewSection
            title={t('settings.plugins.capabilityLabel.hooks')}
            count={selectedPlugin.hookEntries.length}
            emptyLabel={t('settings.plugins.capabilityEmpty')}
          >
            {selectedPlugin.hookEntries.length > 0 ? (
              <div className="grid gap-3 xl:grid-cols-2">
                {selectedPlugin.hookEntries.map((hook, index) => (
                  <HookPreviewCard
                    key={`${hook.event}:${hook.matcher || 'all'}:${index}`}
                    event={hook.event}
                    matcher={hook.matcher}
                    actions={hook.actions}
                  />
                ))}
              </div>
            ) : null}
          </CapabilityPreviewSection>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {otherCapabilityItems.map(({ key, items }) => (
              <div
                key={key}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                    {t(`settings.plugins.capabilityLabel.${key}`)}
                  </div>
                  <span className="text-[11px] text-[var(--color-text-tertiary)]">
                    {items.length}
                  </span>
                </div>
                {items.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {items.map((item) => (
                      <span
                        key={item}
                        className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)] break-all"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-[var(--color-text-tertiary)]">
                    {t('settings.plugins.capabilityEmpty')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={showUninstallDialog}
        onClose={() => {
          if (isApplying && actionKey === 'uninstall') return
          setShowUninstallDialog(false)
        }}
        onConfirm={async () => {
          setShowUninstallDialog(false)
          await runAction('uninstall', () => uninstallPlugin(selectedPlugin.id, selectedPlugin.scope, false, currentWorkDir, activeSessionId || undefined))
        }}
        title={t('settings.plugins.uninstall')}
        body={t('settings.plugins.confirmUninstall', { name: selectedPlugin.name })}
        confirmLabel={t('settings.plugins.uninstall')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isApplying && actionKey === 'uninstall'}
      />
    </div>
  )
}

function CapabilityPreviewSection({
  title,
  count,
  children,
  emptyLabel,
  hint,
}: {
  title: string
  count: number
  children: ReactNode
  emptyLabel: string
  hint?: string
}) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</div>
        <div className="text-[11px] text-[var(--color-text-tertiary)]">{count}</div>
      </div>
      <div className="p-4">
        {hint && count > 0 && (
          <div className="mb-3 text-xs text-[var(--color-text-tertiary)]">{hint}</div>
        )}
        {count > 0 ? children : (
          <div className="text-xs text-[var(--color-text-tertiary)]">{emptyLabel}</div>
        )}
      </div>
    </section>
  )
}

function SkillPreviewCard({
  name,
  rawName,
  description,
  version,
  onClick,
  disabled,
}: {
  name: string
  rawName?: string
  description: string
  version?: string
  onClick: () => void
  disabled?: boolean
}) {
  const t = useTranslation()
  const slashName = rawName || name

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:cursor-default disabled:opacity-70 disabled:hover:border-[var(--color-border)] disabled:hover:bg-[var(--color-surface)]"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="text-sm font-semibold text-[var(--color-text-primary)] break-all">{name}</span>
          {version && (
            <span className="rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
              v{version}
            </span>
          )}
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
            {t('settings.skills.slashCommand')}
          </span>
        </div>
        <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] transition-transform group-hover:translate-x-0.5">
          chevron_right
        </span>
      </div>
      <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)] break-all">/{slashName}</div>
      <div className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)] break-words">{description}</div>
    </button>
  )
}

function CommandPreviewCard({
  name,
  description,
}: {
  name: string
  description: string
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="text-sm font-semibold text-[var(--color-text-primary)] break-all">/{name}</div>
      <div className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)] break-words">{description}</div>
    </div>
  )
}

function AgentPreviewCard({
  name,
  description,
  onClick,
  disabled,
}: {
  name: string
  description: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:cursor-default disabled:opacity-70 disabled:hover:border-[var(--color-border)] disabled:hover:bg-[var(--color-surface)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--color-text-primary)] break-all">{name}</div>
          <div className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)] break-words">{description}</div>
        </div>
        <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] transition-transform group-hover:translate-x-0.5">
          chevron_right
        </span>
      </div>
    </button>
  )
}

function McpPreviewCard({
  name,
  transport,
  summary,
  onClick,
  disabled,
}: {
  name: string
  transport: string
  summary: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:cursor-default disabled:opacity-70 disabled:hover:border-[var(--color-border)] disabled:hover:bg-[var(--color-surface)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-[var(--color-text-primary)] break-all">{name}</span>
            <span className="rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              {transport}
            </span>
          </div>
          <div className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)] break-all">{summary}</div>
        </div>
        <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] transition-transform group-hover:translate-x-0.5">
          chevron_right
        </span>
      </div>
    </button>
  )
}

function HookPreviewCard({
  event,
  matcher,
  actions,
}: {
  event: string
  matcher?: string
  actions: string[]
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-[var(--color-text-primary)] break-all">{event}</span>
        {matcher && (
          <span className="rounded-full bg-[var(--color-surface-container-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)] break-all">
            {matcher}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {actions.map((action) => (
          <span
            key={action}
            className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)] break-all"
          >
            {action}
          </span>
        ))}
      </div>
    </div>
  )
}

function MetaPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
      {children}
    </span>
  )
}

function DetailStat({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: string
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
        <span className="material-symbols-outlined text-[14px]">{icon}</span>
        <span>{label}</span>
      </div>
      <div className="mt-2 text-base font-semibold text-[var(--color-text-primary)] break-all">
        {value}
      </div>
    </div>
  )
}

function StatusPill({
  enabled,
  hasErrors,
}: {
  enabled: boolean
  hasErrors: boolean
}) {
  const t = useTranslation()
  const classes = hasErrors
    ? 'bg-[var(--color-error)]/12 text-[var(--color-error)]'
    : enabled
      ? 'bg-[var(--color-success-container)] text-[var(--color-success)]'
      : 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]'

  const label = hasErrors
    ? t('settings.plugins.status.attention')
    : enabled
      ? t('settings.plugins.status.enabled')
      : t('settings.plugins.status.disabled')

  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${classes}`}>
      {label}
    </span>
  )
}
