import { useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Bot,
  Box,
  ChevronRight,
  Network,
  SquareTerminal,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { usePluginStore } from '../../stores/pluginStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
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
  const fetchServersForKnownProjects = useMcpStore((s) => s.fetchServersForKnownProjects)
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
    return <LoadingState label={t('common.loading')} labelHidden />
  }

  if (!selectedPlugin) return null

  const canMutate = selectedPlugin.scope !== 'managed' && selectedPlugin.scope !== 'builtin'
  const canNavigateSharedCapabilities = selectedPlugin.enabled

  const runAction = async (key: string, fn: () => Promise<string>) => {
    setActionKey(key)
    try {
      const message = await fn()
      // The store applies the change, then reloads the runtime, and resolves
      // either way -- a failed reload only lands in `refreshWarning`. Reporting
      // a plain success here would make "applied but never reloaded" look
      // identical to a clean run. Read it after the call: the store clears it
      // when the mutation starts, so anything present belongs to this action.
      const refreshWarning = usePluginStore.getState().refreshWarning
      if (refreshWarning) {
        addToast({
          type: 'warning',
          message: t('settings.plugins.reloadWarning', { message: refreshWarning }),
        })
      } else {
        addToast({ type: 'success', message })
      }
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

  const openSettingsTab = (tab: 'agents' | 'mcp') => {
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
    useUIStore.getState().setPendingSettingsTab('skills')
    useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
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
    // Query the full known-project set. Fetching only currentWorkDir here
    // used to overwrite the whole store with a one-project view, wiping other
    // projects' servers from the settings list (GH #1126).
    await fetchServersForKnownProjects(currentWorkDir)

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
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          icon={<ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />}
          onClick={clearSelection}
        >
          {t('settings.plugins.back')}
        </Button>
      </div>

      {/* Page head: name and state, one line of facts, then the actions. */}
      <header className="-mt-3 flex min-w-0 flex-col gap-3">
        <div>
          <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.plugins.entryEyebrow')}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="break-all text-[22px] font-semibold leading-[30px] text-[var(--color-text-primary)]">
              {selectedPlugin.name}
            </h2>
            <StatusPill enabled={selectedPlugin.enabled} hasErrors={selectedPlugin.hasErrors} />
          </div>
          <p className="mt-1.5 max-w-[72ch] text-[13px] leading-5 text-[var(--color-text-secondary)]">
            {selectedPlugin.description || t('settings.plugins.noDescription')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--color-text-tertiary)]">
            <span>{t(`settings.plugins.scope.${selectedPlugin.scope}`)}</span>
            <span aria-hidden="true">·</span>
            <span>{selectedPlugin.marketplace}</span>
            {selectedPlugin.version && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[11px]">v{selectedPlugin.version}</span>
              </>
            )}
            {selectedPlugin.authorName && (
              <>
                <span aria-hidden="true">·</span>
                <span>{t('settings.plugins.author', { value: selectedPlugin.authorName })}</span>
              </>
            )}
          </div>
          {(selectedPlugin.projectPath || selectedPlugin.installPath) && (
            <div className="mt-1 flex flex-col gap-0.5 break-all font-mono text-[11px] leading-5 text-[var(--color-text-tertiary)]">
              {selectedPlugin.projectPath && (
                <span>{t('settings.plugins.projectPath', { value: selectedPlugin.projectPath })}</span>
              )}
              {selectedPlugin.installPath && (
                <span>{t('settings.plugins.installPath', { value: selectedPlugin.installPath })}</span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {canMutate && (
            selectedPlugin.enabled ? (
              <Button
                variant="secondary"
                size="base"
                loading={isApplying && actionKey === 'disable'}
                onClick={() => void runAction('disable', () => disablePlugin(selectedPlugin.id, selectedPlugin.scope, currentWorkDir, activeSessionId || undefined))}
              >
                {t('settings.plugins.disable')}
              </Button>
            ) : (
              <Button
                size="base"
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
              size="base"
              loading={isApplying && actionKey === 'update'}
              onClick={() => void runAction('update', () => updatePlugin(selectedPlugin.id, selectedPlugin.scope, currentWorkDir, activeSessionId || undefined))}
            >
              {t('settings.plugins.update')}
            </Button>
          )}

          <Button
            variant="secondary"
            size="base"
            loading={isApplying && actionKey === 'reload'}
            onClick={() => void handleReload()}
          >
            {t('settings.plugins.apply')}
          </Button>

          {canMutate && (
            <Button
              variant="danger-ghost"
              size="base"
              loading={isApplying && actionKey === 'uninstall'}
              onClick={() => {
                setShowUninstallDialog(true)
              }}
            >
              {t('settings.plugins.uninstall')}
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-1 text-xs text-[var(--color-text-tertiary)]">
          {!canMutate && (
            <p>
              {selectedPlugin.scope === 'managed'
                ? t('settings.plugins.managedHint')
                : t('settings.plugins.builtinHint')}
            </p>
          )}
          <p>{t('settings.plugins.applyHint')}</p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <DetailStat
          label={t('settings.plugins.summary.skills')}
          value={String(selectedPlugin.componentCounts.skills)}
          icon={Box}
        />
        <DetailStat
          label={t('settings.plugins.summary.agents')}
          value={String(selectedPlugin.componentCounts.agents)}
          icon={Bot}
        />
        <DetailStat
          label={t('settings.plugins.summary.mcp')}
          value={String(selectedPlugin.componentCounts.mcpServers)}
          icon={Network}
        />
        <DetailStat
          label={t('settings.plugins.summary.hooks')}
          value={String(selectedPlugin.componentCounts.hooks)}
          icon={Zap}
        />
      </div>

      {/* The heading tag and the leading icon are the cost of adopting
          `ErrorState`; `role="alert"` and three fewer alpha fills are what it
          buys. `bg-[var(--color-error)]/6` in particular is the pattern Safari
          15 WebView cannot parse, so this panel had no tint on the desktop
          shell at all. */}
      {selectedPlugin.errors.length > 0 && (
        <ErrorState
          size="lg"
          title={t('settings.plugins.errorsTitle')}
          detail={
            <span className="mt-1 flex flex-col gap-1.5">
              {selectedPlugin.errors.map((error) => (
                <span
                  key={error}
                  className="rounded-[var(--radius-md)] bg-[var(--color-surface-container-lowest)] px-3 py-2 text-[13px] text-[var(--color-text-secondary)]"
                >
                  {error}
                </span>
              ))}
            </span>
          }
        />
      )}

      <section className="flex min-w-0 flex-col gap-4">
        <div className="px-0.5">
          <h3 className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
            {t('settings.plugins.capabilitiesTitle')}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
            {t('settings.plugins.capabilitiesHint')}
          </p>
        </div>

        <CapabilityPreviewSection
          title={t('settings.plugins.capabilityLabel.skills')}
          icon={Box}
          count={selectedPlugin.skillEntries.length}
          emptyLabel={t('settings.plugins.capabilityEmpty')}
          hint={!canNavigateSharedCapabilities ? t('settings.plugins.sharedNavigationDisabled') : undefined}
        >
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
        </CapabilityPreviewSection>

        <CapabilityPreviewSection
          title={t('settings.plugins.capabilityLabel.mcpServers')}
          icon={Network}
          count={selectedPlugin.mcpServerEntries.length}
          emptyLabel={t('settings.plugins.capabilityEmpty')}
          hint={!canNavigateSharedCapabilities ? t('settings.plugins.sharedNavigationDisabled') : undefined}
        >
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
        </CapabilityPreviewSection>

        <CapabilityPreviewSection
          title={t('settings.plugins.capabilityLabel.commands')}
          icon={SquareTerminal}
          count={selectedPlugin.commandEntries.length}
          emptyLabel={t('settings.plugins.capabilityEmpty')}
        >
          {selectedPlugin.commandEntries.map((command) => (
            <CommandPreviewCard
              key={command.name}
              name={command.name}
              description={command.description}
            />
          ))}
        </CapabilityPreviewSection>

        <CapabilityPreviewSection
          title={t('settings.plugins.capabilityLabel.agents')}
          icon={Bot}
          count={selectedPlugin.agentEntries.length}
          emptyLabel={t('settings.plugins.capabilityEmpty')}
          hint={!canNavigateSharedCapabilities ? t('settings.plugins.sharedNavigationDisabled') : undefined}
        >
          {selectedPlugin.agentEntries.map((agent) => (
            <AgentPreviewCard
              key={agent.name}
              name={agent.displayName || agent.name}
              description={agent.description}
              onClick={() => void handleOpenAgent(agent.name)}
              disabled={!canNavigateSharedCapabilities}
            />
          ))}
        </CapabilityPreviewSection>

        <CapabilityPreviewSection
          title={t('settings.plugins.capabilityLabel.hooks')}
          icon={Webhook}
          count={selectedPlugin.hookEntries.length}
          emptyLabel={t('settings.plugins.capabilityEmpty')}
        >
          {selectedPlugin.hookEntries.map((hook, index) => (
            <HookPreviewCard
              key={`${hook.event}:${hook.matcher || 'all'}:${index}`}
              event={hook.event}
              matcher={hook.matcher}
              actions={hook.actions}
            />
          ))}
        </CapabilityPreviewSection>

        {otherCapabilityItems.map(({ key, items }) => (
          <Card key={key} radius="lg" surface="lowest" padding="none" className="overflow-hidden">
            <div className="flex h-10 items-center justify-between gap-2 border-b border-[var(--color-border)] px-4">
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">
                {t(`settings.plugins.capabilityLabel.${key}`)}
              </div>
              <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                {items.length}
              </span>
            </div>
            <div className="px-4 py-3">
              {items.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {items.map((item) => (
                    <Badge key={item} size="sm" wrap mono>
                      {item}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-[var(--color-text-tertiary)]">
                  {t('settings.plugins.capabilityEmpty')}
                </div>
              )}
            </div>
          </Card>
        ))}
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

/**
 * One capability kind: a white card with a 40px header and its entries as
 * rows under hairlines. The entries used to be bordered cards inside a
 * bordered, tinted section inside the page card — three nested frames.
 */
function CapabilityPreviewSection({
  title,
  icon: Icon,
  count,
  children,
  emptyLabel,
  hint,
}: {
  title: string
  icon: LucideIcon
  count: number
  children: ReactNode
  emptyLabel: string
  hint?: string
}) {
  return (
    <Card as="section" radius="lg" surface="lowest" padding="none" className="overflow-hidden">
      <div className="flex h-10 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <Icon className="flex-shrink-0 text-[var(--color-text-tertiary)]" size={15} strokeWidth={1.75} aria-hidden="true" />
        <div className="min-w-0 flex-1 text-[13px] font-medium text-[var(--color-text-primary)]">
          {title}
        </div>
        <div className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{count}</div>
      </div>
      {hint && count > 0 && (
        <div className="border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-tertiary)]">{hint}</div>
      )}
      {count > 0 ? (
        <div className="divide-y divide-[var(--color-border)]">{children}</div>
      ) : (
        <div className="px-4 py-3 text-xs text-[var(--color-text-tertiary)]">{emptyLabel}</div>
      )}
    </Card>
  )
}

/** A clickable entry row: hover fill, chevron, disabled when navigation is off. */
const ENTRY_BUTTON =
  'group flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent'

function EntryChevron() {
  return (
    <ChevronRight
      className="mt-0.5 flex-shrink-0 text-[var(--color-text-tertiary)] opacity-60 transition-opacity group-hover:opacity-100"
      size={14}
      strokeWidth={1.75}
      aria-hidden="true"
    />
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
    <button type="button" onClick={onClick} disabled={disabled} className={ENTRY_BUTTON}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="break-all text-[13px] font-medium text-[var(--color-text-primary)]">{name}</span>
          {version && <Badge mono>v{version}</Badge>}
          <Badge variant="outline">{t('settings.skills.slashCommand')}</Badge>
        </div>
        <div className="mt-0.5 break-all font-mono text-[11px] text-[var(--color-text-tertiary)]">/{slashName}</div>
        <div className="mt-1 break-words text-xs leading-5 text-[var(--color-text-secondary)]">{description}</div>
      </div>
      <EntryChevron />
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
    <div className="px-4 py-3">
      <div className="break-all font-mono text-xs text-[var(--color-text-primary)]">/{name}</div>
      <div className="mt-1 break-words text-xs leading-5 text-[var(--color-text-secondary)]">{description}</div>
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
    <button type="button" onClick={onClick} disabled={disabled} className={ENTRY_BUTTON}>
      <div className="min-w-0">
        <div className="break-all text-[13px] font-medium text-[var(--color-text-primary)]">{name}</div>
        <div className="mt-1 break-words text-xs leading-5 text-[var(--color-text-secondary)]">{description}</div>
      </div>
      <EntryChevron />
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
    <button type="button" onClick={onClick} disabled={disabled} className={ENTRY_BUTTON}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="break-all text-[13px] font-medium text-[var(--color-text-primary)]">{name}</span>
          <Badge mono>{transport}</Badge>
        </div>
        <div className="mt-1 break-all font-mono text-[11px] leading-5 text-[var(--color-text-secondary)]">{summary}</div>
      </div>
      <EntryChevron />
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
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="break-all text-[13px] font-medium text-[var(--color-text-primary)]">{event}</span>
        {/* `wrap` is what unblocked these two: a hook matcher is a regex and an
            action is a shell command, and a nowrap badge pushed both off the
            card. */}
        {matcher && <Badge wrap mono>{matcher}</Badge>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {actions.map((action) => (
          <Badge key={action} size="sm" pill={false} wrap mono>
            {action}
          </Badge>
        ))}
      </div>
    </div>
  )
}

/** Label above, figure below: the figure is what the eye lands on. */
function DetailStat({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: LucideIcon
}) {
  return (
    <Card radius="lg" surface="lowest" padding="none" className="min-w-0 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
        <Icon className="flex-shrink-0" size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 break-all text-[22px] font-semibold leading-7 tabular-nums text-[var(--color-text-primary)]">
        {value}
      </div>
    </Card>
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
  const tone = hasErrors ? 'danger' : enabled ? 'success' : 'neutral'

  const label = hasErrors
    ? t('settings.plugins.status.attention')
    : enabled
      ? t('settings.plugins.status.enabled')
      : t('settings.plugins.status.disabled')

  return <Badge tone={tone}>{label}</Badge>
}
