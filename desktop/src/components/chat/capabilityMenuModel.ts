import {
  Box,
  Bot,
  Compass,
  MonitorSmartphone,
  Ellipsis,
  List,
  Paperclip,
  Plug,
  Settings2,
  Store,
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
import type { NormalizedSkill } from '@/types/market'
import type { WorkflowDefinition } from '@/types/workflow'

/**
 * Data model behind the composer's capability ("+") menu.
 *
 * The menu component (`ComposerCapabilityMenu`) is deliberately dumb: this
 * module decides which sections and rows exist and what each row does, so the
 * whole structure is testable without rendering. Actions are interpreted by
 * `useCapabilityMenu`, shared by both composers.
 *
 * The root has two titled groups: things the user hands to this task (skills,
 * connectors, files — picking one inserts it into the composer) and how the
 * task runs (Agent Team, Computer Use — switches that stay on). Everything
 * else sits under More.
 */

export type CapabilityAction =
  | { type: 'attachment' }
  | { type: 'slashTrigger' }
  /** Insert a mention badge (skill or plugin) into the composer. */
  | { type: 'insertMention', reference: ComposerReferenceCandidate }
  /** Insert `/command ` as plain text (agents and workflows run this way). */
  | { type: 'insertSlashText', command: string }
  | { type: 'settings', tab: SettingsTab }
  /** Open the extension market; a connector id opens that connector's detail. */
  | { type: 'market', section: 'plugins' | 'skills', connectorId?: string }
  /** Install a curated market skill from the menu. */
  | { type: 'installSkill', id: string, name: string }
  /** Open the save-workflow panel above the composer. */
  | { type: 'saveWorkflowPanel' }
  /** Arm or disarm Agent Team for the next message. */
  | { type: 'toggleAgentTeam' }
  /** Flip the global Computer Use switch; turning it on asks for consent first. */
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
  /** Mode rows (Agent Team, Computer Use): an inline switch instead of a chevron. */
  switch?: { checked: boolean, disabled: boolean }
  /** A small button at the end of the row (Connect, Authorize, Install). */
  button?: { label: string, action: CapabilityAction, busy?: boolean }
  /** Connection state dot for connector rows. */
  status?: 'ok' | 'attention'
  /** Sub-list heading this row sits under; consecutive rows share one heading. */
  group?: string
  disabled?: boolean
  disabledReason?: string
  /** Agent rows can tint their icon with the definition's color. */
  iconColor?: string
}

export type CapabilityMenuSection = {
  id: 'use' | 'run' | 'more'
  title: string
  /** Show the title above the rows (the More group is a single row). */
  showTitle: boolean
  items: CapabilityMenuItem[]
  /** Rows reachable only through search (plugins that no sub-list shows). */
  searchOnly?: CapabilityMenuItem[]
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
  /** Skill ids the user sent most recently, newest first. */
  recentSkillIds: string[]
  /** Curated market skills not installed yet, best first. */
  popularSkills: NormalizedSkill[]
  installingSkillIds: ReadonlySet<string>
  agents: AgentDefinition[]
  connectors: ConnectorDto[]
  workflows: WorkflowDefinition[]
  agentTeam: { enabled: boolean, armed: boolean }
  computerUse: CapabilityMenuComputerUse
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}

/** How many installed skills the Skills sub-list lists before "All skills". */
export const RECENT_SKILL_LIMIT = 4
/** How many market skills the Skills sub-list suggests. */
export const POPULAR_SKILL_LIMIT = 2
/** How many uninstalled connectors the Connectors sub-list suggests. */
export const SUGGESTED_CONNECTOR_LIMIT = 3

/**
 * Connectors worth suggesting to someone who has not added them, in order. A
 * fixed list on purpose: suggestions do not follow the task, they show what
 * can be connected at all. Installed ones are skipped, so the next in line
 * moves up.
 */
export const SUGGESTED_CONNECTOR_IDS = [
  'github',
  'feishu',
  'context7',
  'notion',
  'figma',
  'tencent-docs',
  'linear',
  'dingtalk',
  'wecom',
  'amap',
]

function referenceIcon(reference: ComposerReferenceCandidate): CapabilityIcon {
  return reference.icon ? { kind: 'image', src: reference.icon } : { kind: 'lucide', icon: reference.kind === 'plugin' ? Plug : Box }
}

function mentionItem(reference: ComposerReferenceCandidate, group?: string): CapabilityMenuItem {
  return {
    key: `${reference.kind}:${reference.id}`,
    label: reference.displayName || reference.name,
    description: reference.description,
    icon: referenceIcon(reference),
    action: { type: 'insertMention', reference },
    ...(group ? { group } : {}),
  }
}

/** Skill bundles live in the catalog too; they are not services to connect. */
function isServiceConnector(connector: ConnectorDto): boolean {
  return connector.collection !== 'tools' && connector.transport !== 'skills'
}

function isVisibleConnector(connector: ConnectorDto): boolean {
  return connector.supported && isServiceConnector(connector) && isComposerPluginVisible(connector.pluginId)
}

/** Catalog names and descriptions are localized under `connectors.<id>.*`. */
function connectorText(connector: ConnectorDto, field: 'name' | 'description', t: CapabilityMenuInput['t']): string {
  const key = `connectors.${connector.id}.${field}` as TranslationKey
  const translated = t(key)
  if (translated !== key) return translated
  return field === 'name' ? connector.displayName || connector.id : connector.description ?? ''
}

function connectorNeedsAttention(connector: ConnectorDto): boolean {
  return connector.installed && !connector.operation && connector.connection !== 'connected'
    && (connector.connection === 'needs-auth' || connector.status === 'needs-auth' || connector.status === 'error')
}

function buildSkillChildren(input: CapabilityMenuInput): CapabilityMenuItem[] {
  const { t } = input
  const byId = new Map(input.skills.map(skill => [skill.id, skill]))
  const recent = input.recentSkillIds
    .map(id => byId.get(id))
    .filter((skill): skill is ComposerReferenceCandidate => !!skill)
    .slice(0, RECENT_SKILL_LIMIT)
  const recentGroup = t('chat.capabilities.skillsRecent')
  const popularGroup = t('chat.capabilities.skillsPopular')
  const children: CapabilityMenuItem[] = recent.map(skill => mentionItem(skill, recentGroup))
  children.push({
    key: 'skills:all',
    label: t('chat.capabilities.skillsAll'),
    icon: { kind: 'lucide', icon: List },
    count: input.skills.length,
    children: [
      ...input.skills.map(skill => mentionItem(skill)),
      {
        key: 'skills:manage',
        label: t('chat.capabilities.manageSkills'),
        icon: { kind: 'lucide', icon: Settings2 },
        action: { type: 'settings', tab: 'skills' },
      },
    ],
  })
  for (const skill of input.popularSkills.slice(0, POPULAR_SKILL_LIMIT)) {
    const busy = input.installingSkillIds.has(skill.id)
    const install: CapabilityAction = { type: 'installSkill', id: skill.id, name: skill.name }
    children.push({
      key: `market-skill:${skill.id}`,
      label: skill.name,
      description: skill.summary,
      icon: skill.iconUrl ? { kind: 'image', src: skill.iconUrl } : { kind: 'lucide', icon: Box },
      group: popularGroup,
      action: install,
      disabled: busy,
      button: { label: t(busy ? 'chat.capabilities.skillInstalling' : 'chat.capabilities.skillInstall'), action: install, busy },
    })
  }
  children.push({
    key: 'skills:browse',
    label: t('chat.capabilities.skillsBrowse'),
    icon: { kind: 'lucide', icon: Store },
    action: { type: 'market', section: 'skills' },
  })
  return children
}

function buildConnectorChildren(input: CapabilityMenuInput): CapabilityMenuItem[] {
  const { t } = input
  const visible = input.connectors.filter(isVisibleConnector)
  const connectedGroup = t('chat.capabilities.connectorsConnected')
  const attentionGroup = t('chat.capabilities.connectorsNeedsAction')
  const suggestedGroup = t('chat.capabilities.connectorsSuggested')
  const pluginFor = (connector: ConnectorDto) => input.plugins.find(candidate => candidate.id === connector.pluginId)

  const connected: CapabilityMenuItem[] = visible
    .filter(connector => connector.connection === 'connected')
    .map(connector => {
      // A connector backed by an installed plugin can be referenced as a mention;
      // anything else only has a management surface, so the row opens its detail.
      const plugin = pluginFor(connector)
      return {
        key: `connector:${connector.id}`,
        label: connectorText(connector, 'name', t),
        description: plugin?.description ?? connectorText(connector, 'description', t),
        icon: plugin ? referenceIcon(plugin) : { kind: 'lucide', icon: Plug },
        status: 'ok',
        group: connectedGroup,
        action: plugin
          ? { type: 'insertMention', reference: plugin }
          : { type: 'market', section: 'plugins', connectorId: connector.id },
      }
    })
  // Plugins that bring their own MCP servers are connectors to the user, even
  // though no catalog entry describes them.
  const connectorPluginIds = new Set(input.connectors.map(connector => connector.pluginId))
  for (const plugin of input.plugins) {
    if (connectorPluginIds.has(plugin.id) || !plugin.mcpServerNames?.length) continue
    connected.push({ ...mentionItem(plugin, connectedGroup), key: `connector-plugin:${plugin.id}`, status: 'ok' })
  }

  const attention: CapabilityMenuItem[] = visible.filter(connectorNeedsAttention).map(connector => {
    const open: CapabilityAction = { type: 'market', section: 'plugins', connectorId: connector.id }
    const needsAuth = connector.status !== 'error'
    return {
      key: `connector:${connector.id}`,
      label: connectorText(connector, 'name', t),
      description: t(needsAuth ? 'chat.capabilities.connectorNeedsAuth' : 'chat.capabilities.connectorFailed'),
      icon: { kind: 'lucide', icon: Plug },
      status: 'attention',
      group: attentionGroup,
      action: open,
      button: { label: t(needsAuth ? 'chat.capabilities.connectorAuthorize' : 'chat.capabilities.connectorView'), action: open },
    }
  })

  const byId = new Map(visible.map(connector => [connector.id, connector]))
  const suggested: CapabilityMenuItem[] = SUGGESTED_CONNECTOR_IDS
    .map(id => byId.get(id))
    .filter((connector): connector is ConnectorDto => !!connector && !connector.installed && !connector.operation)
    .slice(0, SUGGESTED_CONNECTOR_LIMIT)
    .map(connector => {
      const open: CapabilityAction = { type: 'market', section: 'plugins', connectorId: connector.id }
      return {
        key: `connector:${connector.id}`,
        label: connectorText(connector, 'name', t),
        description: connectorText(connector, 'description', t),
        icon: { kind: 'lucide', icon: Plug },
        group: suggestedGroup,
        action: open,
        button: { label: t('chat.capabilities.connectorConnect'), action: open },
      }
    })

  return [
    ...connected,
    ...attention,
    ...suggested,
    {
      key: 'connectors:browse',
      label: visible.length
        ? t('chat.capabilities.connectorsBrowseCount', { count: visible.length })
        : t('chat.capabilities.connectorsBrowse'),
      icon: { kind: 'lucide', icon: Compass },
      action: { type: 'market', section: 'plugins' },
    },
  ]
}

export function buildCapabilitySections(input: CapabilityMenuInput): CapabilityMenuSection[] {
  const { t } = input

  const connectorChildren = buildConnectorChildren(input)
  const skills: CapabilityMenuItem = {
    key: 'skills',
    label: t('chat.capabilities.skills'),
    description: t('chat.capabilities.skillsDescription'),
    icon: { kind: 'lucide', icon: Box },
    count: input.skills.length,
    children: buildSkillChildren(input),
  }
  const connectors: CapabilityMenuItem = {
    key: 'connectors',
    label: t('chat.capabilities.connectors'),
    description: t('chat.capabilities.connectorsDescription'),
    icon: { kind: 'lucide', icon: Plug },
    count: connectorChildren.filter(item => item.status === 'ok').length,
    children: connectorChildren,
  }

  const agentTeamItem: CapabilityMenuItem = input.agentTeam.enabled
    ? {
        key: 'agent-team',
        label: t('chat.capabilities.teams'),
        description: t('chat.capabilities.teamsDescription'),
        icon: { kind: 'lucide', icon: Users },
        switch: { checked: input.agentTeam.armed, disabled: false },
        action: { type: 'toggleAgentTeam' },
      }
    : {
        // Turned off in Settings: the row leads there instead of arming a
        // mode the session would not honour.
        key: 'agent-team',
        label: t('chat.capabilities.teams'),
        description: t('chat.capabilities.teamsDisabled'),
        icon: { kind: 'lucide', icon: Users },
        action: { type: 'settings', tab: 'general' },
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

  // Plugins are packaging: their skills are listed under Skills and their MCP
  // servers under Connectors. A plugin with neither stays reachable through
  // search, so it can still be mentioned as a whole.
  const listedPluginIds = new Set(connectorChildren.flatMap(item =>
    item.action?.type === 'insertMention' ? [item.action.reference.id] : []))
  const searchOnly = input.plugins
    .filter(plugin => !listedPluginIds.has(plugin.id))
    .map(plugin => mentionItem(plugin))

  return [
    {
      id: 'use',
      title: t('chat.capabilities.sectionUse'),
      showTitle: true,
      items: [
        skills,
        connectors,
        {
          key: 'add-files',
          label: t('chat.addFiles'),
          icon: { kind: 'lucide', icon: Paperclip },
          action: { type: 'attachment' },
        },
      ],
    },
    {
      id: 'run',
      title: t('chat.capabilities.sectionRun'),
      showTitle: true,
      items: [agentTeamItem, computerUseItem],
    },
    {
      id: 'more',
      title: t('chat.capabilities.moreTools'),
      showTitle: false,
      items: [{
        key: 'more',
        label: t('chat.capabilities.moreTools'),
        icon: { kind: 'lucide', icon: Ellipsis },
        children: [
          {
            key: 'agents',
            label: t('chat.capabilities.agents'),
            description: t('chat.capabilities.agentsDescription'),
            icon: { kind: 'lucide', icon: Bot },
            count: agentChildren.length - 1,
            children: agentChildren,
          },
          {
            key: 'workflows',
            label: t('chat.capabilities.workflows'),
            description: t('chat.capabilities.workflowsDescription'),
            icon: { kind: 'lucide', icon: Workflow },
            count: input.workflows.length,
            children: workflowChildren,
          },
          {
            key: 'slash-commands',
            label: t('chat.slashCommands'),
            icon: { kind: 'slash' },
            action: { type: 'slashTrigger' },
          },
        ],
      }],
      searchOnly,
    },
  ]
}
