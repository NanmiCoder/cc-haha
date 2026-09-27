import { useEffect, useMemo, useState } from 'react'
import { agentsApi, type AgentDefinition } from '@/api/agents'
import { computerUseApi } from '@/api/computerUse'
import { connectorsApi } from '@/api/connectors'
import { teamsApi } from '@/api/teams'
import { workflowsApi } from '@/api/workflows'
import { useTranslation } from '@/i18n'
import { MARKET_TAB_ID, SETTINGS_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import type { ConnectorDto } from '@/types/connector'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { TeamSummary } from '@/types/team'
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
 */

export type CapabilityMenuComposerHandlers = {
  /** Insert a skill/plugin mention badge at the cursor. */
  onInsertMention(reference: ComposerReferenceCandidate): void
  /** Insert `/command ` as plain text (agent runs, workflow runs). */
  onInsertSlashText(command: string): void
  /** Fill the composer with a prompt template; the user edits before sending. */
  onInsertPromptSeed(text: string): void
  onAttachment(): void
  /** Insert the bare `/` trigger and open the slash menu. */
  onSlashTrigger(): void
  /** Open the save-workflow panel above the composer. */
  onSaveWorkflow(): void
  onClose(): void
}

type CapabilityMenuData = {
  agents: AgentDefinition[]
  connectors: ConnectorDto[]
  teams: TeamSummary[]
  workflows: WorkflowDefinition[]
  computerUse: { supported: boolean, enabled: boolean } | null
}

const EMPTY_DATA: CapabilityMenuData = {
  agents: [],
  connectors: [],
  teams: [],
  workflows: [],
  computerUse: null,
}

export function useCapabilityMenu(options: {
  open: boolean
  cwd: string
  references: ComposerReferenceCandidate[]
  handlers: CapabilityMenuComposerHandlers
}): { sections: CapabilityMenuSection[], onAction: (action: CapabilityAction) => void } {
  const { open, cwd, references, handlers } = options
  const t = useTranslation()
  const [data, setData] = useState<CapabilityMenuData>(EMPTY_DATA)

  useEffect(() => {
    if (!open) return
    let active = true
    const cwdArg = cwd || undefined

    // Each source is independent: a failing one (e.g. computer-use off macOS)
    // must not blank the others.
    const load = <T,>(request: Promise<T>, apply: (value: T) => Partial<CapabilityMenuData>) => {
      void request.then(value => {
        if (active) setData(previous => ({ ...previous, ...apply(value) }))
      }).catch(() => {})
    }

    load(agentsApi.list(cwdArg), value => ({ agents: value.activeAgents }))
    load(connectorsApi.list(), value => ({ connectors: value.items }))
    load(teamsApi.list(), value => ({ teams: value.teams }))
    load(workflowsApi.list(cwdArg), value => ({ workflows: value.workflows }))
    void (async () => {
      try {
        const status = await computerUseApi.getStatus()
        const config = await computerUseApi.getAuthorizedApps()
        if (active) {
          setData(previous => ({
            ...previous,
            computerUse: { supported: status.supported, enabled: config.enabled },
          }))
        }
      } catch {
        if (active) {
          setData(previous => ({ ...previous, computerUse: { supported: false, enabled: false } }))
        }
      }
    })()

    return () => { active = false }
  }, [open, cwd])

  const sections = useMemo(() => buildCapabilitySections({
    skills: references.filter(reference => reference.kind === 'skill'),
    plugins: references.filter(reference => reference.kind === 'plugin'),
    agents: data.agents,
    connectors: data.connectors,
    teams: data.teams,
    workflows: data.workflows,
    computerUse: data.computerUse,
    teamCreatePrompt: t('chat.capabilities.teamCreatePrompt'),
    t,
  }), [references, data, t])

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
      case 'insertPromptSeed':
        handlers.onInsertPromptSeed(action.text)
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
      case 'connectorsTab':
        useTabStore.getState().openTab(MARKET_TAB_ID, t('sidebar.extensions'), 'market')
        handlers.onClose()
        return
      case 'openTeam':
        // TeamSummary has no lead session id; the detail lookup is one cheap
        // local read and the workbench cannot open without it.
        void teamsApi.get(action.teamName).then(detail => {
          if (detail.leadSessionId) {
            useTabStore.getState().openTeamWorkbenchTab(detail.leadSessionId, action.teamName)
            handlers.onClose()
          }
        }).catch(() => {})
        return
      case 'toggleComputerUse': {
        // Global (not per-session) switch: optimistic flip, roll back on
        // failure. The menu stays open so the user sees the result.
        const next = !data.computerUse?.enabled
        setData(previous => previous.computerUse
          ? { ...previous, computerUse: { ...previous.computerUse, enabled: next } }
          : previous)
        void computerUseApi.setAuthorizedApps({ enabled: next }).catch(error => {
          setData(previous => previous.computerUse
            ? { ...previous, computerUse: { ...previous.computerUse, enabled: !next } }
            : previous)
          useUIStore.getState().addToast({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        })
        return
      }
    }
  }

  return { sections, onAction }
}
