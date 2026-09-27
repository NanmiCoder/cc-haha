import { describe, expect, it } from 'vitest'
import { translate, type TranslationKey } from '@/i18n'
import type { AgentDefinition } from '@/api/agents'
import type { ConnectorDto } from '@/types/connector'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { TeamSummary } from '@/types/team'
import type { WorkflowDefinition } from '@/types/workflow'
import {
  buildCapabilitySections,
  type CapabilityMenuInput,
} from './capabilityMenuModel'

const t = (key: TranslationKey, params?: Record<string, string | number>) =>
  params?.count !== undefined ? `${key}#${params.count}` : key

const skill: ComposerReferenceCandidate = {
  kind: 'skill',
  id: 'design',
  name: 'design',
  displayName: 'Design',
  description: 'Create interfaces',
  source: 'user',
  modelText: 'Use design',
}

const plugin: ComposerReferenceCandidate = {
  kind: 'plugin',
  id: 'feishu-plugin',
  name: 'feishu',
  displayName: 'Feishu',
  description: 'Feishu tools',
  source: 'plugin',
  modelText: 'Use Feishu',
}

const agent: AgentDefinition = {
  agentType: 'debugger',
  description: 'Debug failures',
  source: 'userSettings',
  isActive: true,
}

const inactiveAgent: AgentDefinition = {
  agentType: 'retired',
  source: 'userSettings',
  isActive: false,
}

const connectedConnector = {
  id: 'feishu',
  displayName: 'Feishu',
  pluginId: 'feishu-plugin',
  connection: 'connected',
  enabled: true,
  installed: true,
  supported: true,
  status: 'ready',
} as unknown as ConnectorDto

const plainConnector = {
  id: 'dingtalk',
  displayName: 'DingTalk',
  pluginId: 'dingtalk-plugin',
  connection: 'connected',
  enabled: true,
  installed: true,
  supported: true,
  status: 'ready',
} as unknown as ConnectorDto

const disconnectedConnector = {
  ...plainConnector,
  id: 'wecom',
  connection: 'disconnected',
} as unknown as ConnectorDto

const team: TeamSummary = { name: 'review-team', memberCount: 3 }

const workflow: WorkflowDefinition = {
  name: 'nightly-review',
  description: 'Review the day',
  source: 'userSettings',
}

function buildInput(overrides: Partial<CapabilityMenuInput> = {}): CapabilityMenuInput {
  return {
    skills: [skill],
    plugins: [plugin],
    agents: [agent, inactiveAgent],
    connectors: [connectedConnector, plainConnector, disconnectedConnector],
    teams: [team],
    workflows: [workflow],
    computerUse: { supported: true, enabled: false },
    teamCreatePrompt: 'Create a team: ',
    t,
    ...overrides,
  }
}

function sectionsById(input: CapabilityMenuInput) {
  const sections = buildCapabilitySections(input)
  const items = sections.flatMap(section => section.items).flatMap(item => item.key === 'more' ? item.children! : [item])
  return new Map([['capabilities', { items }]])
}

describe('buildCapabilitySections', () => {
  it('puts skills and plugins first and groups secondary tools under More', () => {
    const sections = buildCapabilitySections(buildInput())
    expect(sections[0]!.items.map(item => item.key)).toEqual(['skills', 'plugins'])
    expect(sections[1]!.items[0]!.action).toEqual({ type: 'attachment' })
    expect(sections[2]!.items.map(item => item.key)).toEqual(['computer-use', 'more'])
    expect(sections[2]!.items[1]!.children!.map(item => item.key)).toEqual(['connectors', 'agents', 'teams', 'workflows', 'slash-commands'])
  })

  it('lists skills as mention insertions with a manage footer', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const skills = capabilities.items.find(item => item.key === 'skills')!
    expect(skills.count).toBe(1)
    expect(skills.children!.map(child => child.key)).toEqual(['skill:design', 'skills:manage'])
    expect(skills.children![0]!.action).toEqual({ type: 'insertMention', reference: skill })
    expect(skills.children![1]!.action).toEqual({ type: 'settings', tab: 'skills' })
  })

  it('lists only connected connectors, preferring a plugin mention when one exists', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const connectors = capabilities.items.find(item => item.key === 'connectors')!
    expect(connectors.count).toBe(2)
    expect(connectors.children!.map(child => child.key)).toEqual([
      'connector:feishu',
      'connector:dingtalk',
      'connectors:manage',
    ])
    // Feishu has an installed plugin candidate → mention; DingTalk does not → catalog.
    expect(connectors.children![0]!.action).toEqual({ type: 'insertMention', reference: plugin })
    expect(connectors.children![1]!.action).toEqual({ type: 'connectorsTab' })
    expect(connectors.children![2]!.action).toEqual({ type: 'connectorsTab' })
  })

  it('lists active agents as /agent text insertions and skips inactive ones', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const agents = capabilities.items.find(item => item.key === 'agents')!
    expect(agents.count).toBe(1)
    expect(agents.children![0]).toMatchObject({
      key: 'agent:debugger',
      action: { type: 'insertSlashText', command: 'agent debugger' },
    })
    expect(agents.children!.some(child => child.key === 'agent:retired')).toBe(false)
    expect(agents.children!.at(-1)!.action).toEqual({ type: 'settings', tab: 'agents' })
  })

  it('leads the teams sub-list with a prompt-seed creation row, then existing teams', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const teams = capabilities.items.find(item => item.key === 'teams')!
    expect(teams.count).toBe(1)
    expect(teams.children![0]!.action).toEqual({ type: 'insertPromptSeed', text: 'Create a team: ' })
    expect(teams.children![1]).toMatchObject({
      key: 'team:review-team',
      description: 'chat.capabilities.teamMembers#3',
      action: { type: 'openTeam', teamName: 'review-team' },
    })
  })

  it('renders Computer Use as a switch only when the platform supports it', () => {
    const supported = sectionsById(buildInput()).get('capabilities')!
    const switchRow = supported.items.find(item => item.key === 'computer-use')!
    expect(switchRow.switch).toEqual({ checked: false, disabled: false })
    expect(switchRow.action).toEqual({ type: 'toggleComputerUse' })

    const unsupported = sectionsById(buildInput({ computerUse: { supported: false, enabled: false } })).get('capabilities')!
    const navRow = unsupported.items.find(item => item.key === 'computer-use')!
    expect(navRow.switch).toBeUndefined()
    expect(navRow.action).toEqual({ type: 'settings', tab: 'computerUse' })

    // Status not loaded yet: same navigation fallback, never a dead switch.
    const unknown = sectionsById(buildInput({ computerUse: null })).get('capabilities')!
    expect(unknown.items.find(item => item.key === 'computer-use')!.action)
      .toEqual({ type: 'settings', tab: 'computerUse' })
  })

  it('lists workflows as /name text insertions with a save footer', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const workflows = capabilities.items.find(item => item.key === 'workflows')!
    expect(workflows.count).toBe(1)
    expect(workflows.children![0]!.action).toEqual({ type: 'insertSlashText', command: 'nightly-review' })
    expect(workflows.children!.at(-1)!.action).toEqual({ type: 'saveWorkflowPanel' })
  })
})

it('exposes every mentionable plugin even without a connected connector', () => {
  const plugins = buildCapabilitySections(buildInput({ connectors: [] }))[0]!.items[1]!
  expect(plugins.children![0]!.action).toEqual({ type: 'insertMention', reference: plugin })
  expect(plugins.children!.at(-1)!.action).toEqual({ type: 'settings', tab: 'plugins' })
})

 it('keeps withdrawn installed packages out of the secondary connector list', () => {
  const hidden = { ...connectedConnector, id: 'frontend-design', pluginId: 'office-frontend-design@haha-connectors' } as ConnectorDto
  const sections = buildCapabilitySections(buildInput({ connectors: [hidden, connectedConnector] }))
  const more = sections.flatMap(section => section.items).find(item => item.key === 'more')!
  const connectors = more.children!.find(item => item.key === 'connectors')!
  expect(connectors.count).toBe(1)
  expect(connectors.children!.some(item => item.key === 'connector:frontend-design')).toBe(false)
  expect(connectors.children!.some(item => item.key === 'connector:feishu')).toBe(true)
})

it.each([
  ['zh', '操作电脑'],
  ['zh-TW', '操作電腦'],
  ['en', 'Computer use'],
  ['jp', 'コンピューター操作'],
  ['kr', '컴퓨터 조작'],
] as const)('localizes the computer-use menu entry in %s', (locale, label) => {
  const sections = buildCapabilitySections(buildInput({ t: (key, params) => translate(locale, key, params) }))
  const entry = sections.flatMap(section => section.items).find(item => item.key === 'computer-use')!
  expect(entry.label).toBe(label)
  expect(entry.switch).toEqual({ checked: false, disabled: false })
})
