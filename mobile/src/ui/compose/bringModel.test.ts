import { describe, expect, test } from 'bun:test'
import type { ComposerCandidate, ComposerReference } from '../../core/composerReferences'
import type { RecentItem } from '../../core/recentSkills'
import type { Connector } from '../../core/connectors'
import {
  agentBringItems,
  assembleBringItems,
  appendInsertText,
  applyBringSelection,
  bringEntries,
  bringItemFromReference,
  candidateBringItems,
  connectorBringItems,
  doneLabel,
  initialSelection,
  matchRanges,
  mergeBringItems,
  normalizeAgents,
  normalizeWorkflows,
  probeList,
  resolveRecents,
  searchBringItems,
  showDone,
  splitByRanges,
  toRecent,
  toggleBringItem,
  workflowBringItems,
  type BringItem,
} from './bringModel'

const reference = (kind: 'skill' | 'plugin', id: string, displayName: string, extra: Partial<ComposerReference> = {}): ComposerReference => ({
  kind,
  id,
  name: id,
  displayName,
  description: `${displayName}的说明`,
  modelText: `use ${id}`,
  ...extra,
})
const review = reference('skill', 'cr', '代码审查', { description: '按团队规范审一遍改动' })
const feishu = reference('plugin', 'feishu@market', '飞书插件', { description: '审批、日历、文档', mcpServerNames: ['feishu'] })
const helper = reference('plugin', 'helper@market', '小帮手')
const candidates: ComposerCandidate[] = [
  { name: 'cr', description: review.description, kind: 'skill', reference: review },
  { name: 'feishu', description: feishu.description, kind: 'plugin', reference: feishu },
  { name: 'helper', description: helper.description, kind: 'plugin', reference: helper },
  { name: 'review', description: '审查当前分支的改动', kind: 'command' },
  { name: 'security-review', description: '审查待提交改动的安全问题', kind: 'command' },
  { name: 'compact', description: '压缩上下文', kind: 'command' },
]
const items = candidateBringItems(candidates, { lean: false })
const find = (key: string) => items.find((item) => item.key === key)!

describe('catalog to items', () => {
  test('skills and commands are separate groups; a plugin that brings an MCP server is a connector', () => {
    expect(items.map((item) => [item.key, item.group])).toEqual([
      ['ref:skill:cr', 'skill'],
      ['ref:plugin:feishu@market', 'connector'],
      ['ref:plugin:helper@market', 'skill'],
      ['command:review', 'command'],
      ['command:security-review', 'command'],
      ['command:compact', 'command'],
    ])
    expect(find('ref:skill:cr').token).toBe('@代码审查')
    expect(find('command:review')).toMatchObject({ token: '/review', insertText: '/review ' })
  })

  test('lean profile keeps skills and commands only', () => {
    const lean = candidateBringItems(candidates, { lean: true })
    expect(lean.map((item) => item.key)).toEqual(['ref:skill:cr', 'command:review', 'command:security-review', 'command:compact'])
  })

  test('entry rows form two cards like the desktop menu, and empty groups have no row', () => {
    expect(bringEntries(items)).toEqual([
      [
        { group: 'skill', title: '技能', count: 2 },
        { group: 'connector', title: '连接器', count: 1 },
      ],
      [{ group: 'command', title: '斜杠命令', count: 3 }],
    ])
    expect(bringEntries([])).toEqual([])
  })

  test('connectors, agents and workflows get a row as soon as their catalog loaded, even when empty', () => {
    const rows = bringEntries(items, { connector: true, agent: true, workflow: true })
    expect(rows.map((card) => card.map((entry) => entry.group))).toEqual([
      ['skill', 'connector'],
      ['agent', 'workflow', 'command'],
    ])
    expect(rows[1]!.slice(0, 2).map((entry) => entry.count)).toEqual([0, 0])
    // Nothing loaded and no plugin connectors: no connector row at all.
    expect(bringEntries(candidateBringItems([candidates[0]!], { lean: false }), { connector: false, agent: false, workflow: false }))
      .toEqual([[{ group: 'skill', title: '技能', count: 1 }]])
    const withoutPlugin = candidateBringItems([candidates[0]!, candidates[3]!], { lean: false })
    expect(bringEntries(withoutPlugin, { connector: false, agent: false, workflow: false }).flat().map((entry) => entry.group)).toEqual(['skill', 'command'])
  })

  test('agents and workflows become text insertions, inactive agents are left out', () => {
    expect(
      agentBringItems([
        { agentType: 'reviewer', description: '审代码' },
        { agentType: 'old', isActive: false },
      ])
    ).toMatchObject([{ key: 'agent:reviewer', insertText: '/agent reviewer ', group: 'agent' }])
    expect(workflowBringItems([{ name: 'ship', description: '发版' }])).toMatchObject([
      { key: 'workflow:ship', insertText: '/ship ', group: 'workflow', description: '发版' },
    ])
  })

  const catalog: Connector[] = [
    { id: 'feishu', displayName: '飞书', pluginId: 'feishu@market', connection: 'connected', installed: true, supported: true, status: 'ready' },
    { id: 'github', displayName: 'GitHub', pluginId: 'github@market', description: '代码托管', connection: 'connected', installed: true, supported: true, status: 'ready' },
    { id: 'dingtalk', displayName: '钉钉', description: '消息、审批', installed: true, connection: 'needs-auth', supported: true, status: 'needs-auth' },
    { id: 'broken', displayName: '坏了', installed: true, connection: 'disconnected', status: 'error', supported: true },
    { id: 'tools', displayName: '工具集', collection: 'tools', installed: true, connection: 'needs-auth', supported: true },
    { id: 'busy', displayName: '处理中', installed: true, connection: 'needs-auth', operation: {}, supported: true },
    { id: 'context7', displayName: 'Context7', description: '查文档', installed: false, connection: 'disconnected', supported: true },
    { id: 'notion', displayName: 'Notion', installed: false, connection: 'disconnected', supported: true },
    { id: 'amap', displayName: '高德', installed: false, connection: 'disconnected', supported: true },
    { id: 'windows-only', displayName: '别的平台', installed: false, connection: 'disconnected', supported: false },
  ]
  const fromCatalog = connectorBringItems(catalog, items)
  const row = (key: string) => fromCatalog.find((item) => item.key === key)!

  test('connector rows follow the desktop sections: connected, needs attention, suggestions, rest', () => {
    expect(fromCatalog.map((item) => [item.key, item.section])).toEqual([
      ['ref:plugin:feishu@market', 'connected'],
      ['connector:github', 'connected'],
      ['connector:dingtalk', 'attention'],
      ['connector:broken', 'attention'],
      ['connector:context7', 'suggested'],
      ['connector:notion', 'suggested'],
      ['connector:amap', 'suggested'],
      ['connector:busy', 'rest'],
    ])
  })

  test('every connector row carries its id so the logo can be found, in every section', () => {
    expect(fromCatalog.map((item) => item.iconId)).toEqual([
      'feishu',
      'github',
      'dingtalk',
      'broken',
      'context7',
      'notion',
      'amap',
      'busy',
    ])
  })

  test('a connected connector with its plugin can be picked as a reference; without one it is shown only', () => {
    expect(row('ref:plugin:feishu@market')).toMatchObject({ token: '飞书', dot: 'ok' })
    expect(row('ref:plugin:feishu@market').reference).toBe(feishu)
    expect(row('ref:plugin:feishu@market').unavailable).toBeUndefined()
    expect(row('connector:github')).toMatchObject({ dot: 'ok', unavailable: '在电脑上管理', tone: 'muted' })
    expect(toggleBringItem([], row('connector:github'))).toEqual([])
  })

  test('needing authorization or erroring is flagged amber and cannot be picked; the tap says what to do', () => {
    expect(row('connector:dingtalk')).toMatchObject({ dot: 'attn', unavailable: '需授权', tone: 'attn', notice: '请在电脑上完成授权', description: '需要登录授权' })
    expect(row('connector:broken')).toMatchObject({ dot: 'attn', unavailable: '需处理', tone: 'attn', description: '连接出错' })
    expect(toggleBringItem([], row('connector:dingtalk'))).toEqual([])
  })

  test('suggestions are not installable from the phone: they say to connect on the computer', () => {
    expect(row('connector:context7')).toMatchObject({ unavailable: '在电脑上连接', tone: 'muted', description: '查文档' })
    expect(row('connector:context7').dot).toBeUndefined()
    expect(row('connector:busy').unavailable).toBe('在电脑上管理')
    expect(toggleBringItem([], row('connector:notion'))).toEqual([])
  })

  test('tool collections and unsupported platforms never appear', () => {
    const keys = fromCatalog.map((item) => item.key)
    expect(keys).not.toContain('connector:tools')
    expect(keys).not.toContain('connector:windows-only')
  })

  test('the connector entry counts connected ones only', () => {
    const all = assembleBringItems({ candidates, lean: false, extras: { agents: null, workflows: null, connectors: catalog } })
    const connector = bringEntries(all, { connector: true, agent: false, workflow: false })[0]!.find((entry) => entry.group === 'connector')!
    expect(connector.count).toBe(2)
  })

  test('merging keeps one row per plugin and prefers the catalog name', () => {
    const merged = mergeBringItems(items, fromCatalog)
    expect(merged.filter((item) => item.key === 'ref:plugin:feishu@market')).toHaveLength(1)
    expect(merged.find((item) => item.key === 'ref:plugin:feishu@market')!.token).toBe('飞书')
  })

  test('probe responses that are not lists count as unavailable', () => {
    expect(probeList({ items: [1, 2] }, 'items')).toEqual([1, 2])
    expect(probeList({ error: 'FORBIDDEN' }, 'items')).toBeNull()
    expect(probeList(null, 'items')).toBeNull()
    expect(probeList('x', 'items')).toBeNull()
  })
})

describe('search', () => {
  test('highlight ranges cover every occurrence of every term, merged', () => {
    expect(matchRanges('审查当前分支的审查', '审')).toEqual([[0, 1], [7, 8]])
    expect(matchRanges('/security-review', 'sec rev')).toEqual([[1, 4], [10, 13]])
    expect(matchRanges('abcd', 'bc cd')).toEqual([[1, 4]])
    expect(matchRanges('Review', 'REV')).toEqual([[0, 3]])
    expect(matchRanges('anything', '  ')).toEqual([])
    expect(matchRanges('', '审')).toEqual([])
  })

  test('text splits into plain and highlighted pieces that rebuild the original', () => {
    const parts = splitByRanges('按团队规范审一遍', matchRanges('按团队规范审一遍', '审'))
    expect(parts).toEqual([
      { text: '按团队规范', hit: false },
      { text: '审', hit: true },
      { text: '一遍', hit: false },
    ])
    expect(splitByRanges('abc', [])).toEqual([{ text: 'abc', hit: false }])
    expect(splitByRanges('abc', [[0, 3]])).toEqual([{ text: 'abc', hit: true }])
  })

  test('results are grouped as skills, commands, connectors, with the matching characters marked', () => {
    const groups = searchBringItems(mergeBringItems(items), '审')
    expect(groups.map((group) => [group.group, group.title, group.hits.map((hit) => hit.item.key)])).toEqual([
      ['skill', '技能', ['ref:skill:cr']],
      ['command', '命令', ['command:review', 'command:security-review']],
      ['connector', '连接器', ['ref:plugin:feishu@market']],
    ])
    const skill = groups[0]!.hits[0]!
    expect(skill.titleRanges).toEqual([[3, 4]])
    expect(skill.descriptionRanges).toEqual([[5, 6]])
    expect(groups[1]!.hits[0]!.descriptionRanges).toEqual([[0, 1]])
  })

  test('every term must match, title matches come before description-only matches', () => {
    const list: BringItem[] = [
      { key: 'a', group: 'command', token: '/deploy', name: 'deploy', description: 'run review before shipping' },
      { key: 'b', group: 'command', token: '/review', name: 'review', description: 'review a branch' },
      { key: 'c', group: 'command', token: '/my-review', name: 'my-review', description: 'x' },
    ]
    expect(searchBringItems(list, 'review')[0]!.hits.map((hit) => hit.item.key)).toEqual(['b', 'c', 'a'])
    expect(searchBringItems(list, 'review branch')[0]!.hits.map((hit) => hit.item.key)).toEqual(['b'])
    expect(searchBringItems(list, 'nothing')).toEqual([])
    expect(searchBringItems(list, '   ')).toEqual([])
  })
})

describe('selection and 完成', () => {
  test('tapping toggles an item and keeps the order they were picked in', () => {
    const a = find('command:review')
    const b = find('ref:skill:cr')
    let selected: BringItem[] = []
    selected = toggleBringItem(selected, a)
    selected = toggleBringItem(selected, b)
    expect(selected.map((item) => item.key)).toEqual(['command:review', 'ref:skill:cr'])
    expect(toggleBringItem(selected, a).map((item) => item.key)).toEqual(['ref:skill:cr'])
  })

  test('the button label counts the selection, with the full-width brackets from the design', () => {
    expect(doneLabel(0)).toBe('完成')
    expect(doneLabel(2)).toBe('完成（2）')
  })

  test('the root page shows 完成 only after the selection changed; sub pages and search always do', () => {
    const initial = initialSelection([review])
    expect(initial.map((item) => item.key)).toEqual(['ref:skill:cr'])
    expect(showDone({ page: 'root', searching: false, selected: initial, initial })).toBe(false)
    expect(showDone({ page: 'root', searching: false, selected: [...initial, find('command:review')], initial })).toBe(true)
    expect(showDone({ page: 'root', searching: false, selected: [], initial })).toBe(true)
    expect(showDone({ page: 'list', searching: false, selected: initial, initial })).toBe(true)
    expect(showDone({ page: 'root', searching: true, selected: initial, initial })).toBe(true)
  })

  test('applying adds skills as references and commands as text, and reports only what is new', () => {
    const initial = initialSelection([review])
    const result = applyBringSelection({
      draft: '帮我看看',
      initial,
      selected: [...initial, find('ref:plugin:helper@market'), find('command:review'), find('command:compact')],
    })
    expect(result.references.map((value) => value.id)).toEqual(['cr', 'helper@market'])
    expect(result.draft).toBe('帮我看看 /review /compact ')
    expect(result.added.map((item) => item.key)).toEqual(['ref:plugin:helper@market', 'command:review', 'command:compact'])
  })

  test('unchecking a skill that was already in the box removes it, and nothing is appended twice', () => {
    const initial = initialSelection([review, helper])
    const result = applyBringSelection({ draft: '检查 ', initial, selected: initial.filter((item) => item.reference?.id !== 'cr') })
    expect(result.references.map((value) => value.id)).toEqual(['helper@market'])
    expect(result.draft).toBe('检查 ')
    expect(result.added).toEqual([])
  })

  test('agents and workflows write their command text into the draft', () => {
    const agent = agentBringItems([{ agentType: 'reviewer' }])[0]!
    const flow = workflowBringItems([{ name: 'ship' }])[0]!
    expect(applyBringSelection({ draft: '', initial: [], selected: [agent, flow] }).draft).toBe('/agent reviewer /ship ')
  })

  test('appending adds one space only when the draft does not already end in whitespace', () => {
    expect(appendInsertText('', '/a ')).toBe('/a ')
    expect(appendInsertText('改一下', '/a ')).toBe('改一下 /a ')
    expect(appendInsertText('改一下\n', '/a ')).toBe('改一下\n/a ')
  })

  test('the same plugin chosen twice is one reference', () => {
    const doubled = applyBringSelection({
      draft: '',
      initial: [],
      selected: [bringItemFromReference(review), bringItemFromReference({ ...review })],
    })
    expect(doubled.references).toHaveLength(1)
  })
})

describe('recent items', () => {
  const recent = (key: string, usedAt: number): RecentItem => ({ key, kind: 'command', name: key, description: '', usedAt })

  test('only items still in the catalog and pickable are shown, newest first, at most four', () => {
    const catalog = [...items, ...connectorBringItems([{ id: 'x', displayName: '未授权', installed: true, connection: 'needs-auth' }], items)]
    const recents = [
      recent('command:gone', 9),
      recent('connector:x', 8),
      recent('command:compact', 7),
      recent('ref:skill:cr', 6),
      recent('command:review', 5),
      recent('ref:plugin:helper@market', 4),
      recent('command:security-review', 3),
    ]
    expect(resolveRecents(recents, catalog).map((item) => item.key)).toEqual([
      'command:compact',
      'ref:skill:cr',
      'command:review',
      'ref:plugin:helper@market',
    ])
    expect(resolveRecents(recents, catalog, 2)).toHaveLength(2)
    expect(resolveRecents(recents, [])).toEqual([])
  })

  test('what is stored for a chosen item is enough to find it again by key', () => {
    expect(toRecent(find('ref:skill:cr'))).toEqual({ key: 'ref:skill:cr', kind: 'skill', name: 'cr', displayName: '代码审查', description: review.description })
    expect(toRecent(find('command:review')).kind).toBe('command')
    expect(toRecent(agentBringItems([{ agentType: 'a' }])[0]!).kind).toBe('agent')
    expect(toRecent(workflowBringItems([{ name: 'w' }])[0]!).kind).toBe('workflow')
    expect(toRecent(find('ref:plugin:feishu@market')).kind).toBe('plugin')
  })
})

describe('assembling every source', () => {
  const connectors: Connector[] = [
    { id: 'feishu', displayName: '飞书', pluginId: 'feishu@market', connection: 'connected', installed: true, supported: true },
    { id: 'helper', displayName: '小帮手连接器', pluginId: 'helper@market', connection: 'needs-auth', installed: true, supported: true, status: 'needs-auth' },
  ]
  const all = assembleBringItems({
    candidates,
    lean: false,
    extras: {
      connectors,
      agents: [{ agentType: 'reviewer', description: '审代码' }, { agentType: 'off', isActive: false }],
      workflows: [{ name: 'ship', description: '发版' }],
    },
  })
  const keys = (group: BringItem['group']) => all.filter((item) => item.group === group).map((item) => item.key)

  test('all five groups are present with the inserts the desktop uses', () => {
    expect(keys('skill')).toEqual(['ref:skill:cr', 'ref:plugin:helper@market'])
    expect(keys('connector')).toEqual(['ref:plugin:feishu@market', 'connector:helper'])
    expect(keys('agent')).toEqual(['agent:reviewer'])
    expect(keys('workflow')).toEqual(['workflow:ship'])
    expect(keys('command')).toEqual(['command:review', 'command:security-review', 'command:compact'])
    expect(all.find((item) => item.key === 'agent:reviewer')!.insertText).toBe('/agent reviewer ')
    expect(all.find((item) => item.key === 'workflow:ship')!.insertText).toBe('/ship ')
  })

  test('a plugin owned by an unconnected connector falls back to a searchable skill, not a connector', () => {
    const helperItem = all.find((item) => item.key === 'ref:plugin:helper@market')!
    expect(helperItem.group).toBe('skill')
    expect(helperItem.token).toBe('@小帮手')
  })

  test('without the connector catalog, plugins that bring an MCP server still show as connectors', () => {
    const fallback = assembleBringItems({ candidates, lean: false, extras: { connectors: null, agents: null, workflows: null } })
    expect(fallback.filter((item) => item.group === 'connector').map((item) => item.key)).toEqual(['ref:plugin:feishu@market'])
    expect(fallback.some((item) => item.group === 'agent' || item.group === 'workflow')).toBe(false)
  })

  test('lean keeps skills and slash commands only, whatever was probed', () => {
    const lean = assembleBringItems({
      candidates,
      lean: true,
      extras: { connectors, agents: [{ agentType: 'a' }], workflows: [{ name: 'w' }] },
    })
    expect(new Set(lean.map((item) => item.group))).toEqual(new Set(['skill', 'command']))
    expect(bringEntries(lean).flat().map((entry) => entry.group)).toEqual(['skill', 'command'])
  })

  test('search finds connectors (including suggestions), agents and workflows, grouped in order', () => {
    const searchable = assembleBringItems({
      candidates,
      lean: false,
      extras: {
        connectors: [...connectors, { id: 'notion', displayName: 'Notion 文档', installed: false, connection: 'disconnected', supported: true }],
        agents: [{ agentType: 'doc-writer', description: '写文档' }],
        workflows: [{ name: 'doc-sync', description: '同步文档' }],
      },
    })
    const groups = searchBringItems(searchable, '文档')
    expect(groups.map((group) => [group.group, group.hits.map((hit) => hit.item.key)])).toEqual([
      ['connector', ['connector:notion', 'ref:plugin:feishu@market']],
      ['agent', ['agent:doc-writer']],
      ['workflow', ['workflow:doc-sync']],
    ])
  })
})

describe('reading the three desktop endpoints', () => {
  test('agents come from activeAgents; entries without a type are dropped', () => {
    expect(normalizeAgents({ activeAgents: [{ agentType: 'a', description: 'd', isActive: true, color: 'blue' }, { description: 'x' }, null], allAgents: [{ agentType: 'hidden' }] }))
      .toEqual([{ agentType: 'a', description: 'd', isActive: true }])
    expect(normalizeAgents({ allAgents: [] })).toBeNull()
    expect(normalizeAgents({ error: 'Desktop-only capability' })).toBeNull()
  })

  test('workflows come from the workflows list', () => {
    expect(normalizeWorkflows({ workflows: [{ name: 'ship', description: '发版', filePath: '/x' }, { description: 'no name' }] }))
      .toEqual([{ name: 'ship', description: '发版' }])
    expect(normalizeWorkflows({ items: [] })).toBeNull()
    expect(normalizeWorkflows(undefined)).toBeNull()
  })
})
