import { describe, expect, it } from 'vitest'
import { translate, type TranslationKey } from '@/i18n'
import type { AgentDefinition } from '@/api/agents'
import type { ConnectorDto } from '@/types/connector'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { NormalizedSkill } from '@/types/market'
import type { WorkflowDefinition } from '@/types/workflow'
import {
  buildCapabilitySections,
  type CapabilityMenuInput,
  type CapabilityMenuItem,
} from './capabilityMenuModel'

const t = (key: TranslationKey, params?: Record<string, string | number>) =>
  params?.count !== undefined ? `${key}#${params.count}` : key

function skill(id: string): ComposerReferenceCandidate {
  return { kind: 'skill', id, name: id, displayName: id, description: `${id} skill`, source: 'user', modelText: `Use ${id}` }
}

const design = skill('design')

const feishuPlugin: ComposerReferenceCandidate = {
  kind: 'plugin',
  id: 'feishu-plugin',
  name: 'feishu',
  displayName: 'Feishu',
  description: 'Feishu tools',
  source: 'plugin',
  modelText: 'Use Feishu',
}

const mcpPlugin: ComposerReferenceCandidate = {
  kind: 'plugin',
  id: 'sentry-tools@team',
  name: 'sentry-tools',
  displayName: 'Sentry tools',
  description: 'Bring Sentry issues',
  source: 'plugin',
  modelText: 'Use Sentry tools',
  mcpServerNames: ['sentry'],
}

const docsPlugin: ComposerReferenceCandidate = {
  kind: 'plugin',
  id: 'document-skills@anthropic',
  name: 'document-skills',
  displayName: 'Document skills',
  description: 'PDF and Word',
  source: 'plugin',
  modelText: 'Use document skills',
  skillNames: ['pdf', 'docx'],
}

const agent: AgentDefinition = { agentType: 'debugger', description: 'Debug failures', source: 'userSettings', isActive: true }
const inactiveAgent: AgentDefinition = { agentType: 'retired', source: 'userSettings', isActive: false }

function connector(id: string, overrides: Partial<ConnectorDto> = {}): ConnectorDto {
  return {
    id,
    displayName: id,
    description: `${id} service`,
    pluginId: `${id}@haha-connectors`,
    connection: 'disconnected',
    enabled: false,
    installed: false,
    supported: true,
    status: 'not-installed',
    transport: 'mcp',
    ...overrides,
  } as unknown as ConnectorDto
}

const feishu = connector('feishu', { pluginId: 'feishu-plugin', connection: 'connected', installed: true, enabled: true, status: 'ready' })
const dingtalk = connector('dingtalk', { connection: 'connected', installed: true, enabled: true, status: 'ready' })

const popular: NormalizedSkill = {
  id: 'clawhub:excalidraw',
  source: 'clawhub',
  slug: 'excalidraw',
  name: 'excalidraw',
  summary: 'Hand-drawn diagrams',
  author: { handle: 'someone' },
  stats: { downloads: 10 },
  tags: [],
  securityStatus: 'verified',
  installState: 'installable',
}

const workflow: WorkflowDefinition = { name: 'nightly-review', description: 'Review the day', source: 'userSettings' }

function buildInput(overrides: Partial<CapabilityMenuInput> = {}): CapabilityMenuInput {
  return {
    skills: [design],
    plugins: [feishuPlugin],
    recentSkillIds: [],
    popularSkills: [],
    installingSkillIds: new Set(),
    agents: [agent, inactiveAgent],
    connectors: [feishu, dingtalk],
    workflows: [workflow],
    agentTeam: { enabled: true, armed: false },
    computerUse: { supported: true, enabled: false },
    t,
    ...overrides,
  }
}

function rootItem(input: CapabilityMenuInput, key: string): CapabilityMenuItem {
  const item = buildCapabilitySections(input).flatMap(section => section.items).find(candidate => candidate.key === key)
  if (!item) throw new Error(`missing root item ${key}`)
  return item
}

function moreItem(input: CapabilityMenuInput, key: string): CapabilityMenuItem {
  const item = rootItem(input, 'more').children!.find(candidate => candidate.key === key)
  if (!item) throw new Error(`missing More item ${key}`)
  return item
}

const keys = (items: CapabilityMenuItem[]) => items.map(item => item.key)

describe('buildCapabilitySections', () => {
  it('splits the root into things for this task, how it runs, and More', () => {
    const sections = buildCapabilitySections(buildInput())
    expect(sections.map(section => [section.id, section.title, section.showTitle])).toEqual([
      ['use', 'chat.capabilities.sectionUse', true],
      ['run', 'chat.capabilities.sectionRun', true],
      ['more', 'chat.capabilities.moreTools', false],
    ])
    expect(keys(sections[0]!.items)).toEqual(['skills', 'connectors', 'add-files'])
    expect(sections[0]!.items[2]!.action).toEqual({ type: 'attachment' })
    expect(keys(sections[1]!.items)).toEqual(['agent-team', 'computer-use'])
    expect(keys(sections[2]!.items[0]!.children!)).toEqual(['agents', 'workflows', 'slash-commands'])
  })

  it('leads Skills with recent ones, then all skills, market picks and the market', () => {
    const skills = [design, skill('pdf'), skill('git'), skill('lint'), skill('deploy'), skill('notes')]
    const item = rootItem(buildInput({
      skills,
      // Newest first; an id that is no longer installed is skipped.
      recentSkillIds: ['git', 'uninstalled', 'design', 'pdf', 'lint', 'deploy', 'notes'],
      popularSkills: [popular, { ...popular, id: 'clawhub:pptx', name: 'pptx' }, { ...popular, id: 'clawhub:third', name: 'third' }],
    }), 'skills')

    expect(item.count).toBe(6)
    expect(keys(item.children!)).toEqual([
      'skill:git', 'skill:design', 'skill:pdf', 'skill:lint',
      'skills:all',
      'market-skill:clawhub:excalidraw', 'market-skill:clawhub:pptx',
      'skills:browse',
    ])
    expect(item.children!.slice(0, 4).every(child => child.group === 'chat.capabilities.skillsRecent')).toBe(true)
    expect(item.children![0]!.action).toEqual({ type: 'insertMention', reference: skills[2] })

    const all = item.children![4]!
    expect(all.count).toBe(6)
    expect(keys(all.children!)).toEqual([...skills.map(candidate => `skill:${candidate.id}`), 'skills:manage'])
    expect(all.children!.at(-1)!.action).toEqual({ type: 'settings', tab: 'skills' })

    const install = { type: 'installSkill', id: 'clawhub:excalidraw', name: 'excalidraw' }
    expect(item.children![5]).toMatchObject({
      group: 'chat.capabilities.skillsPopular',
      action: install,
      button: { label: 'chat.capabilities.skillInstall', action: install, busy: false },
    })
    expect(item.children!.at(-1)!.action).toEqual({ type: 'market', section: 'skills' })
  })

  it('opens Skills on the full list when nothing was used yet, and marks an install in flight', () => {
    const item = rootItem(buildInput({ popularSkills: [popular], installingSkillIds: new Set([popular.id]) }), 'skills')
    expect(keys(item.children!)).toEqual(['skills:all', 'market-skill:clawhub:excalidraw', 'skills:browse'])
    expect(item.children![1]).toMatchObject({
      disabled: true,
      button: { label: 'chat.capabilities.skillInstalling', busy: true },
    })
  })

  it('groups connectors into connected, needing attention and three suggestions', () => {
    const item = rootItem(buildInput({
      plugins: [feishuPlugin, mcpPlugin, docsPlugin],
      connectors: [
        feishu,
        dingtalk,
        connector('notion', { installed: true, connection: 'needs-auth', status: 'needs-auth' }),
        connector('linear', { installed: true, status: 'error' }),
        // Mid-operation rows are left to the market page.
        connector('miro', { installed: true, connection: 'needs-auth', status: 'needs-auth', operation: { id: 'op', kind: 'authenticate', phase: 'waiting', startedAt: '' } }),
        connector('github'),
        connector('context7'),
        connector('figma'),
        connector('tencent-docs'),
        // Skill bundles and unsupported services are never suggested.
        connector('remotion', { collection: 'tools', transport: 'skills' }),
        connector('wecom', { supported: false }),
      ],
    }), 'connectors')

    expect(keys(item.children!)).toEqual([
      'connector:feishu', 'connector:dingtalk', 'connector-plugin:sentry-tools@team',
      'connector:notion', 'connector:linear',
      'connector:github', 'connector:context7', 'connector:figma',
      'connectors:browse',
    ])
    expect(item.count).toBe(3)
    // Feishu has an installed plugin candidate → mention; DingTalk does not → its detail.
    expect(item.children![0]).toMatchObject({ status: 'ok', group: 'chat.capabilities.connectorsConnected', action: { type: 'insertMention', reference: feishuPlugin } })
    expect(item.children![1]!.action).toEqual({ type: 'market', section: 'plugins', connectorId: 'dingtalk' })
    expect(item.children![2]!.action).toEqual({ type: 'insertMention', reference: mcpPlugin })

    const authorize = { type: 'market', section: 'plugins', connectorId: 'notion' }
    expect(item.children![3]).toMatchObject({
      status: 'attention',
      group: 'chat.capabilities.connectorsNeedsAction',
      description: 'chat.capabilities.connectorNeedsAuth',
      button: { label: 'chat.capabilities.connectorAuthorize', action: authorize },
    })
    expect(item.children![4]).toMatchObject({ description: 'chat.capabilities.connectorFailed', button: { label: 'chat.capabilities.connectorView' } })

    expect(item.children![5]).toMatchObject({
      group: 'chat.capabilities.connectorsSuggested',
      button: { label: 'chat.capabilities.connectorConnect', action: { type: 'market', section: 'plugins', connectorId: 'github' } },
    })
    expect(item.children!.at(-1)).toMatchObject({
      label: 'chat.capabilities.connectorsBrowseCount#9',
      action: { type: 'market', section: 'plugins' },
    })
  })

  it('suggests the next connectors in line once the first ones are installed', () => {
    const item = rootItem(buildInput({
      connectors: [
        connector('github', { installed: true, connection: 'connected', status: 'ready' }),
        connector('feishu', { installed: true, connection: 'connected', status: 'ready' }),
        connector('amap'),
        connector('notion'),
        connector('context7'),
        connector('figma'),
      ],
    }), 'connectors')
    expect(item.children!.filter(child => child.group === 'chat.capabilities.connectorsSuggested').map(child => child.key))
      .toEqual(['connector:context7', 'connector:notion', 'connector:figma'])
  })

  it('still offers to browse connectors before the catalog has loaded', () => {
    const item = rootItem(buildInput({ connectors: [], plugins: [] }), 'connectors')
    expect(item.count).toBe(0)
    expect(item.children!.map(child => [child.key, child.label])).toEqual([['connectors:browse', 'chat.capabilities.connectorsBrowse']])
  })

  it('shows plugins through their skills and connectors, keeping the rest searchable', () => {
    const sections = buildCapabilitySections(buildInput({ plugins: [feishuPlugin, mcpPlugin, docsPlugin] }))
    const allKeys = (items: CapabilityMenuItem[]): string[] => items.flatMap(item => [item.key, ...allKeys(item.children ?? [])])
    expect(allKeys(sections.flatMap(section => section.items)).some(key => key === 'plugins' || key.startsWith('plugin:'))).toBe(false)
    const searchOnly = sections.flatMap(section => section.searchOnly ?? [])
    expect(searchOnly.map(item => item.action)).toEqual([{ type: 'insertMention', reference: docsPlugin }])
  })

  it('makes Agent Team a switch, or a way to Settings when it is turned off there', () => {
    const armed = rootItem(buildInput({ agentTeam: { enabled: true, armed: true } }), 'agent-team')
    expect(armed.switch).toEqual({ checked: true, disabled: false })
    expect(armed.action).toEqual({ type: 'toggleAgentTeam' })

    const off = rootItem(buildInput({ agentTeam: { enabled: false, armed: true } }), 'agent-team')
    expect(off.switch).toBeUndefined()
    expect(off.description).toBe('chat.capabilities.teamsDisabled')
    expect(off.action).toEqual({ type: 'settings', tab: 'general' })
  })

  it('renders Computer Use as a switch only when the platform supports it', () => {
    const switchRow = rootItem(buildInput(), 'computer-use')
    expect(switchRow.switch).toEqual({ checked: false, disabled: false })
    expect(switchRow.action).toEqual({ type: 'toggleComputerUse' })

    const navRow = rootItem(buildInput({ computerUse: { supported: false, enabled: false } }), 'computer-use')
    expect(navRow.switch).toBeUndefined()
    expect(navRow.action).toEqual({ type: 'settings', tab: 'computerUse' })

    // Status not loaded yet: same navigation fallback, never a dead switch.
    expect(rootItem(buildInput({ computerUse: null }), 'computer-use').action)
      .toEqual({ type: 'settings', tab: 'computerUse' })
  })

  it('lists active agents as /agent text insertions and skips inactive ones', () => {
    const agents = moreItem(buildInput(), 'agents')
    expect(agents.count).toBe(1)
    expect(agents.children![0]).toMatchObject({ key: 'agent:debugger', action: { type: 'insertSlashText', command: 'agent debugger' } })
    expect(agents.children!.some(child => child.key === 'agent:retired')).toBe(false)
    expect(agents.children!.at(-1)!.action).toEqual({ type: 'settings', tab: 'agents' })
  })

  it('lists workflows as /name text insertions with a save footer', () => {
    const workflows = moreItem(buildInput(), 'workflows')
    expect(workflows.count).toBe(1)
    expect(workflows.children![0]!.action).toEqual({ type: 'insertSlashText', command: 'nightly-review' })
    expect(workflows.children!.at(-1)!.action).toEqual({ type: 'saveWorkflowPanel' })
  })
})

it('keeps withdrawn installed packages out of the connector list', () => {
  const hidden = { ...feishu, id: 'frontend-design', pluginId: 'office-frontend-design@haha-connectors' } as ConnectorDto
  const connectors = rootItem(buildInput({ connectors: [hidden, feishu] }), 'connectors')
  expect(connectors.count).toBe(1)
  expect(connectors.children!.some(item => item.key === 'connector:frontend-design')).toBe(false)
  expect(connectors.children!.some(item => item.key === 'connector:feishu')).toBe(true)
})

it.each([
  ['zh', '操作电脑', '给这次任务用', '运行方式'],
  ['zh-TW', '操作電腦', '給這次任務用', '執行方式'],
  ['en', 'Computer use', 'For this task', 'How it runs'],
  ['jp', 'コンピューター操作', 'このタスクで使う', '実行方法'],
  ['kr', '컴퓨터 조작', '이번 작업에 사용', '실행 방식'],
] as const)('localizes the menu groups and the computer-use entry in %s', (locale, label, useTitle, runTitle) => {
  const sections = buildCapabilitySections(buildInput({ t: (key, params) => translate(locale, key, params) }))
  expect(sections.slice(0, 2).map(section => section.title)).toEqual([useTitle, runTitle])
  const entry = sections.flatMap(section => section.items).find(item => item.key === 'computer-use')!
  expect(entry.label).toBe(label)
  expect(entry.switch).toEqual({ checked: false, disabled: false })
})

it('uses the localized catalog name and description of a connector', () => {
  const sections = buildCapabilitySections(buildInput({
    connectors: [connector('feishu', { displayName: 'feishu-cli', description: 'raw' })],
    t: (key, params) => translate('zh', key, params),
  }))
  const suggestion = sections[0]!.items[1]!.children!.find(item => item.key === 'connector:feishu')!
  expect(suggestion.label).toBe(translate('zh', 'connectors.feishu.name'))
  expect(suggestion.description).toBe(translate('zh', 'connectors.feishu.description'))
})
