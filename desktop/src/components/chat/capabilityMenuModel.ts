import {
  Box,
  Bot,
  MonitorSmartphone,
  Ellipsis,
  Paperclip,
  Plug,
  Settings2,
  Sparkles,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { isComposerPluginVisible } from '@/lib/composerCapabilityVisibility'
import type { TranslationKey } from '@/i18n'
import type { SettingsTab } from '@/stores/uiStore'
import type { AgentDefinition } from '@/api/agents'
import type { ConnectorDto } from '@/types/connector'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { TeamSummary } from '@/types/team'
import type { WorkflowDefinition } from '@/types/workflow'

/**
 * Data model behind the composer's capability ("+") menu.
 *
 * The menu component (`ComposerCapabilityMenu`) is deliberately dumb: this
 * module decides which sections and rows exist and what each row does, so the
 * whole structure is testable without rendering. Actions are interpreted by
 * the two composers (ChatInput / EmptySession), which own the actual composer
 * state, stores and panels.
 */

export type CapabilityAction =
  | { type: 'attachment' }
  | { type: 'slashTrigger' }
  /** Insert a mention badge (skill or plugin) into the composer. */
  | { type: 'insertMention', reference: ComposerReferenceCandidate }
  /** Insert `/command ` as plain text (agents and workflows run this way). */
  | { type: 'insertSlashText', command: string }
  /** Fill the composer with a prompt template the user edits before sending. */
  | { type: 'insertPromptSeed', text: string }
  /** Open an existing team's workbench tab. */
  | { type: 'openTeam', teamName: string }
  | { type: 'settings', tab: SettingsTab }
  /** Open the market tab that hosts the connector catalog. */
  | { type: 'connectorsTab' }
  /** Open the save-workflow panel above the composer. */
  | { type: 'saveWorkflowPanel' }
  /** Flip the global Computer Use switch. */
  | { type: 'toggleComputerUse' }

export type CapabilityIcon =
  | { kind: 'lucide', icon: LucideIcon }
  | { kind: 'image', src: string }
  | { kind: 'slash' }

export type CapabilityMenuItem = {
  key: string
  label: string
  description?: string
  icon: CapabilityIcon
  /** Trailing count ("12") for rows that open a sub-list. */
  count?: number
  /** Rows that open a sub-list show a chevron; leaf rows execute `action`. */
  children?: CapabilityMenuItem[]
  action?: CapabilityAction
  /** Computer Use row: an inline switch instead of a chevron. */
  switch?: { checked: boolean, disabled: boolean }
  disabled?: boolean
  disabledReason?: string
  /** Agent rows can tint their icon with the definition's color. */
  iconColor?: string
}

export type CapabilityMenuSection = {
  id: 'add' | 'capabilities' | 'commands'
  title: string
  items: CapabilityMenuItem[]
}

export type CapabilityMenuComputerUse = {
  supported: boolean
  enabled: boolean
} | null

export type CapabilityMenuInput = {
  /** Skill mention candidates (kind 'skill'), already loaded for the composer. */
  skills: ComposerReferenceCandidate[]
  /** Plugin mention candidates (kind 'plugin'), already loaded for the composer. */
  plugins: ComposerReferenceCandidate[]
  agents: AgentDefinition[]
  connectors: ConnectorDto[]
  teams: TeamSummary[]
  workflows: WorkflowDefinition[]
  computerUse: CapabilityMenuComputerUse
  /** Translated seed text for the "create a team" prompt row. */
  teamCreatePrompt: string
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}

function referenceIcon(reference: ComposerReferenceCandidate): CapabilityIcon {
  return reference.icon ? { kind: 'image', src: reference.icon } : { kind: 'lucide', icon: reference.kind === 'plugin' ? Plug : Box }
}

function connectorStatusCount(connectors: ConnectorDto[]): number {
  return connectors.filter(connector => connector.connection === 'connected' && isComposerPluginVisible(connector.pluginId)).length
}

export function buildCapabilitySections(input: CapabilityMenuInput): CapabilityMenuSection[] {
  const { t } = input

  const skillChildren: CapabilityMenuItem[] = input.skills.map(skill => ({
    key: `skill:${skill.id}`,
    label: skill.displayName || skill.name,
    description: skill.description,
    icon: referenceIcon(skill),
    action: { type: 'insertMention', reference: skill },
  }))
  skillChildren.push({
    key: 'skills:manage',
    label: t('chat.capabilities.manageSkills'),
    icon: { kind: 'lucide', icon: Settings2 },
    action: { type: 'settings', tab: 'skills' },
  })

  const pluginChildren: CapabilityMenuItem[] = input.plugins.map(plugin => ({
    key: `plugin:${plugin.id}`,
    label: plugin.displayName || plugin.name,
    description: plugin.description,
    icon: referenceIcon(plugin),
    action: { type: 'insertMention', reference: plugin },
  }))
  pluginChildren.push({
    key: 'plugins:manage',
    label: t('chat.capabilities.managePlugins'),
    icon: { kind: 'lucide', icon: Settings2 },
    action: { type: 'settings', tab: 'plugins' },
  })

  const connected = input.connectors.filter(connector => connector.connection === 'connected' && isComposerPluginVisible(connector.pluginId))
  const connectorChildren: CapabilityMenuItem[] = connected.map(connector => {
    // A connector backed by an installed plugin can be referenced as a mention;
    // anything else only has a management surface, so the row opens the catalog.
    const plugin = input.plugins.find(candidate => candidate.id === connector.pluginId)
    return {
      key: `connector:${connector.id}`,
      label: connector.displayName || connector.id,
      description: plugin?.description ?? connector.description,
      icon: plugin ? referenceIcon(plugin) : { kind: 'lucide', icon: Plug },
      action: plugin
        ? { type: 'insertMention', reference: plugin }
        : { type: 'connectorsTab' },
    }
  })
  connectorChildren.push({
    key: 'connectors:manage',
    label: t('chat.capabilities.manageConnectors'),
    icon: { kind: 'lucide', icon: Settings2 },
    action: { type: 'connectorsTab' },
  })

  const agentChildren: CapabilityMenuItem[] = input.agents
    .filter(agent => agent.isActive)
    .map(agent => ({
      key: `agent:${agent.agentType}`,
      label: agent.agentType,
      description: agent.description,
      icon: { kind: 'lucide', icon: Bot },
      iconColor: agent.color,
      action: { type: 'insertSlashText', command: `agent ${agent.agentType}` },
    }))
  agentChildren.push({
    key: 'agents:manage',
    label: t('chat.capabilities.manageAgents'),
    icon: { kind: 'lucide', icon: Settings2 },
    action: { type: 'settings', tab: 'agents' },
  })

  const teamChildren: CapabilityMenuItem[] = [{
    key: 'teams:create',
    label: t('chat.capabilities.teamCreate'),
    description: t('chat.capabilities.teamCreateDescription'),
    icon: { kind: 'lucide', icon: Sparkles },
    action: { type: 'insertPromptSeed', text: input.teamCreatePrompt },
  }]
  for (const team of input.teams) {
    teamChildren.push({
      key: `team:${team.name}`,
      label: team.name,
      description: t('chat.capabilities.teamMembers', { count: team.memberCount }),
      icon: { kind: 'lucide', icon: Users },
      action: { type: 'openTeam', teamName: team.name },
    })
  }

  const computerUseItem: CapabilityMenuItem = input.computerUse?.supported
    ? {
        key: 'computer-use',
        label: t('chat.capabilities.computerUse'),
        description: t('chat.capabilities.computerUseDescription'),
        icon: { kind: 'lucide', icon: MonitorSmartphone },
        switch: { checked: input.computerUse.enabled, disabled: false },
        action: { type: 'toggleComputerUse' },
      }
    : {
        // Unsupported platform (or status not loaded yet): the row is a
        // navigation entry to the settings page, never a dead switch.
        key: 'computer-use',
        label: t('chat.capabilities.computerUse'),
        description: input.computerUse
          ? t('chat.capabilities.computerUseUnsupported')
          : t('chat.capabilities.computerUseDescription'),
        icon: { kind: 'lucide', icon: MonitorSmartphone },
        action: { type: 'settings', tab: 'computerUse' },
      }

  // Workflows are read from the same on-disk location the CLI loads at session
  // start, so inserting `/name` is safe even before the session reports its
  // command list — the CLI picks the file up when the session launches.
  const workflowChildren: CapabilityMenuItem[] = input.workflows.map(workflow => ({
    key: `workflow:${workflow.source}:${workflow.name}`,
    label: workflow.name,
    description: workflow.description,
    icon: { kind: 'lucide', icon: Workflow },
    action: { type: 'insertSlashText', command: workflow.name },
  }))
  workflowChildren.push({
    key: 'workflows:save',
    label: t('chat.capabilities.saveWorkflow'),
    icon: { kind: 'lucide', icon: Workflow },
    action: { type: 'saveWorkflowPanel' },
  })

  const sections: CapabilityMenuSection[] = [
    {
      id: 'add',
      title: t('chat.capabilities.sectionAdd'),
      items: [{
        key: 'add-files',
        label: t('chat.addFiles'),
        icon: { kind: 'lucide', icon: Paperclip },
        action: { type: 'attachment' },
      }],
    },
    {
      id: 'capabilities',
      title: t('chat.capabilities.sectionCapabilities'),
      items: [
        {
          key: 'skills',
          label: t('chat.capabilities.skills'),
          description: t('chat.capabilities.skillsDescription'),
          icon: { kind: 'lucide', icon: Box },
          count: input.skills.length,
          children: skillChildren,
        },
        {
          key: 'connectors',
          label: t('chat.capabilities.connectors'),
          description: t('chat.capabilities.connectorsDescription'),
          icon: { kind: 'lucide', icon: Plug },
          count: connectorStatusCount(input.connectors),
          children: connectorChildren,
        },
        {
          key: 'agents',
          label: t('chat.capabilities.agents'),
          description: t('chat.capabilities.agentsDescription'),
          icon: { kind: 'lucide', icon: Bot },
          count: agentChildren.length - 1,
          children: agentChildren,
        },
        {
          key: 'teams',
          label: t('chat.capabilities.teams'),
          description: t('chat.capabilities.teamsDescription'),
          icon: { kind: 'lucide', icon: Users },
          count: input.teams.length,
          children: teamChildren,
        },
        computerUseItem,
        {
          key: 'workflows',
          label: t('chat.capabilities.workflows'),
          description: t('chat.capabilities.workflowsDescription'),
          icon: { kind: 'lucide', icon: Workflow },
          count: input.workflows.length,
          children: workflowChildren,
        },
      ],
    },
    {
      id: 'commands',
      title: t('chat.capabilities.sectionCommands'),
      items: [{
        key: 'slash-commands',
        label: t('chat.slashCommands'),
        icon: { kind: 'slash' },
        action: { type: 'slashTrigger' },
      }],
    },
  ]
  const capabilities = sections[1]!.items
  const primary = capabilities.filter(item => item.key === 'skills')
  primary.push({
    key: 'plugins',
    label: t('chat.referencePlugins'),
    icon: { kind: 'lucide', icon: Plug },
    count: input.plugins.length,
    children: pluginChildren,
  })
  return [
    { ...sections[1]!, items: primary },
    sections[0]!,
    {
      ...sections[2]!,
      items: [computerUseItem, {
        key: 'more',
        label: t('chat.capabilities.moreTools'),
        icon: { kind: 'lucide', icon: Ellipsis },
        children: [...capabilities.filter(item => item.key !== 'skills' && item.key !== 'computer-use'), ...sections[2]!.items],
      }],
    },
  ]
}
