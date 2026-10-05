import { useEffect, useMemo, useState } from 'react'
import { agentsApi, type AgentDefinition } from '@/api/agents'
import { computerUseApi, type ComputerUseStatus } from '@/api/computerUse'
import { connectorsApi } from '@/api/connectors'
import { marketApi } from '@/api/market'
import { workflowsApi } from '@/api/workflows'
import { useTranslation } from '@/i18n'
import { COMPUTER_USE_ENABLE_REQUEST, needsComputerUsePermissionCard } from '@/lib/computerUseEnable'
import { readRecentSkills } from '@/lib/recentSkills'
import { useMarketStore } from '@/stores/marketStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSkillStore } from '@/stores/skillStore'
import { MARKET_TAB_ID, SETTINGS_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import type { ConnectorDto } from '@/types/connector'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { NormalizedSkill } from '@/types/market'
import type { WorkflowDefinition } from '@/types/workflow'
import {
  buildCapabilitySections,
  type CapabilityAction,
  type CapabilityMenuSection,
} from './capabilityMenuModel'

/**
 * Data and action interpretation for the composer's capability menu, shared by
 * both composers (ChatInput and EmptySession) so the two stay identical by
 * construction rather than by a parity test.
 *
 * Parents refresh the shared skill/plugin references on each +, @ or slash
 * menu opening and clear stale entries while loading. This hook lazy-loads
 * the remaining capabilities and re-fetches them on each opening because
 * Settings can change while a session is running. Fetches are dropped when
 * the menu closes mid-flight.
 *
 * It also owns the composer's Agent Team switch (armed for the next message)
 * and the Computer Use consent dialog the menu's switch opens.
 */

export type CapabilityMenuComposerHandlers = {
  /** Insert a skill/plugin mention badge at the cursor. */
  onInsertMention(reference: ComposerReferenceCandidate): void
  /** Insert `/command ` as plain text (agent runs, workflow runs). */
  onInsertSlashText(command: string): void
  onAttachment(): void
  /** Insert the bare `/` trigger and open the slash menu. */
  onSlashTrigger(): void
  /** Open the save-workflow panel above the composer. */
  onSaveWorkflow(): void
  /** A skill was installed from the menu: reload the mention candidates. */
  onReferencesChanged(): void
  onClose(): void
}

export type ComputerUseConsent = {
  open: boolean
  loading: boolean
  platform: 'darwin' | 'win32'
  onClose(): void
  onConfirm(): Promise<void>
}

type CapabilityMenuData = {
  agents: AgentDefinition[]
  connectors: ConnectorDto[]
  workflows: WorkflowDefinition[]
  computerUse: { supported: boolean, enabled: boolean, status: ComputerUseStatus | null } | null
}

const EMPTY_DATA: CapabilityMenuData = {
  agents: [],
  connectors: [],
  workflows: [],
  computerUse: null,
}

const SAFE_SECURITY = new Set(['verified', 'benign'])

/**
 * Curated skills to suggest: installable, cleanly scanned, usable right after
 * the one-click install (no API key to set up), editor picks first.
 */
export function pickPopularSkills(items: NormalizedSkill[]): NormalizedSkill[] {
  return items
    .filter(skill => skill.installState === 'installable' && SAFE_SECURITY.has(skill.securityStatus) && !skill.requiresApiKey)
    .map((skill, index) => ({ skill, index }))
    .sort((a, b) => Number(!!b.skill.featured) - Number(!!a.skill.featured) || a.index - b.index)
    .map(({ skill }) => skill)
}

// The curated catalog ships with the app and barely changes during a run, so
// one read serves every composer; an install drops its entry locally.
let popularSkillsRequest: Promise<NormalizedSkill[]> | null = null
function loadPopularSkills(): Promise<NormalizedSkill[]> {
  popularSkillsRequest ??= marketApi.list({ scope: 'catalog', installed: 'installable', limit: 30 })
    .then(response => pickPopularSkills(response.items))
    .catch((error: unknown) => {
      popularSkillsRequest = null
      throw error
    })
  return popularSkillsRequest
}

/** Tests only: forget the shared catalog read. */
export function resetPopularSkillsCache(): void {
  popularSkillsRequest = null
}

export function useCapabilityMenu(options: {
  open: boolean
  cwd: string
  references: ComposerReferenceCandidate[]
  handlers: CapabilityMenuComposerHandlers
}): {
  sections: CapabilityMenuSection[]
  onAction: (action: CapabilityAction) => void
  /** Agent Team is armed for the next message. */
  agentTeamArmed: boolean
  disarmAgentTeam(): void
  computerUseConsent: ComputerUseConsent
} {
  const { open, cwd, references, handlers } = options
  const t = useTranslation()
  const [data, setData] = useState<CapabilityMenuData>(EMPTY_DATA)
  const [popularSkills, setPopularSkills] = useState<NormalizedSkill[]>([])
  const [recentSkillIds, setRecentSkillIds] = useState<string[]>([])
  const [armed, setArmed] = useState(false)
  const [consent, setConsent] = useState<{ open: boolean, loading: boolean }>({ open: false, loading: false })
  const agentTeamsEnabled = useSettingsStore(state => state.agentTeamsEnabled)
  const installingSkillIds = useMarketStore(state => state.installingIds)
  const agentTeamArmed = armed && agentTeamsEnabled

  useEffect(() => {
    if (!open) return
    let active = true
    const cwdArg = cwd || undefined
    setRecentSkillIds(readRecentSkills())

    // Each source is independent: a failing one (e.g. computer-use off macOS)
    // must not blank the others.
    const load = <T,>(request: Promise<T>, apply: (value: T) => Partial<CapabilityMenuData>) => {
      void request.then(value => {
        if (active) setData(previous => ({ ...previous, ...apply(value) }))
      }).catch(() => {})
    }

    load(agentsApi.list(cwdArg), value => ({ agents: value.activeAgents }))
    load(connectorsApi.list(), value => ({ connectors: value.items }))
    load(workflowsApi.list(cwdArg), value => ({ workflows: value.workflows }))
    void loadPopularSkills().then(items => {
      if (active) setPopularSkills(items)
    }).catch(() => {})
    void (async () => {
      try {
        const status = await computerUseApi.getStatus()
        const config = await computerUseApi.getAuthorizedApps()
        if (active) {
          setData(previous => ({
            ...previous,
            computerUse: { supported: status.supported, enabled: config.enabled, status },
          }))
        }
      } catch {
        if (active) {
          setData(previous => ({ ...previous, computerUse: { supported: false, enabled: false, status: null } }))
        }
      }
    })()

    return () => { active = false }
  }, [open, cwd])

  const sections = useMemo(() => buildCapabilitySections({
    skills: references.filter(reference => reference.kind === 'skill'),
    plugins: references.filter(reference => reference.kind === 'plugin'),
    recentSkillIds,
    popularSkills,
    installingSkillIds,
    agents: data.agents,
    connectors: data.connectors,
    workflows: data.workflows,
    agentTeam: { enabled: agentTeamsEnabled, armed: agentTeamArmed },
    computerUse: data.computerUse,
    t,
  }), [references, recentSkillIds, popularSkills, installingSkillIds, data, agentTeamsEnabled, agentTeamArmed, t])

  const setComputerUseEnabled = (enabled: boolean) => setData(previous => previous.computerUse
    ? { ...previous, computerUse: { ...previous.computerUse, enabled } }
    : previous)

  const installSkill = async (id: string, name: string) => {
    const market = useMarketStore.getState()
    const ok = await market.install(id)
    if (ok) {
      useUIStore.getState().addToast({ type: 'success', message: t('market.installSuccess', { name }) })
      popularSkillsRequest = popularSkillsRequest?.then(items => items.filter(skill => skill.id !== id)) ?? null
      setPopularSkills(previous => previous.filter(skill => skill.id !== id))
      handlers.onReferencesChanged()
      // Keep the Settings → Skills browser in sync.
      void useSkillStore.getState().fetchSkills()
      return
    }
    const error = useMarketStore.getState().installError
    if (error) {
      useUIStore.getState().addToast({
        type: 'error',
        message: error.kind === 'generic'
          ? t('market.installError.generic', { message: error.message })
          : t(`market.installError.${error.kind}`),
      })
    }
  }

  const onAction = (action: CapabilityAction) => {
    switch (action.type) {
      case 'attachment':
        handlers.onAttachment()
        return
      case 'slashTrigger':
        handlers.onSlashTrigger()
        return
      case 'insertMention':
        handlers.onInsertMention(action.reference)
        handlers.onClose()
        return
      case 'insertSlashText':
        handlers.onInsertSlashText(action.command)
        handlers.onClose()
        return
      case 'saveWorkflowPanel':
        handlers.onSaveWorkflow()
        handlers.onClose()
        return
      case 'settings':
        useUIStore.getState().setPendingSettingsTab(action.tab)
        useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
        handlers.onClose()
        return
      case 'market':
        useUIStore.getState().setPendingMarketTarget({ section: action.section, connectorId: action.connectorId })
        useTabStore.getState().openTab(MARKET_TAB_ID, t('sidebar.extensions'), 'market')
        handlers.onClose()
        return
      case 'installSkill':
        // The menu stays open: the row turns into "Installing…" and then
        // leaves the suggestions once the skill shows up under All skills.
        void installSkill(action.id, action.name)
        return
      case 'toggleAgentTeam':
        setArmed(previous => !previous)
        return
      case 'toggleComputerUse': {
        // Turning it on goes through the same consent dialog as Settings —
        // that confirmation is what authorizes every app.
        if (!data.computerUse?.enabled) {
          setConsent({ open: true, loading: false })
          handlers.onClose()
          return
        }
        // Global (not per-session) switch: optimistic flip, roll back on
        // failure. The menu stays open so the user sees the result.
        setComputerUseEnabled(false)
        void computerUseApi.setAuthorizedApps({ enabled: false }).catch(error => {
          setComputerUseEnabled(true)
          useUIStore.getState().addToast({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        })
        return
      }
    }
  }

  const computerUseConsent: ComputerUseConsent = {
    open: consent.open,
    loading: consent.loading,
    platform: data.computerUse?.status?.platform === 'win32' ? 'win32' : 'darwin',
    onClose: () => setConsent({ open: false, loading: false }),
    onConfirm: async () => {
      setConsent({ open: true, loading: true })
      try {
        await computerUseApi.setAuthorizedApps(COMPUTER_USE_ENABLE_REQUEST)
      } catch {
        setConsent({ open: true, loading: false })
        useUIStore.getState().addToast({ type: 'error', message: t('settings.computerUse.configSaveFailed') })
        return
      }
      setComputerUseEnabled(true)
      setConsent({ open: false, loading: false })
      if (needsComputerUsePermissionCard(data.computerUse?.status)) {
        try {
          const result = await computerUseApi.openPermissionCard()
          if (!result.ok) throw new Error(result.reason ?? 'permission card failed')
        } catch {
          useUIStore.getState().addToast({ type: 'warning', message: t('settings.computerUse.openCardFailed') })
        }
      }
    },
  }

  return {
    sections,
    onAction,
    agentTeamArmed,
    disarmAgentTeam: () => setArmed(false),
    computerUseConsent,
  }
}
