import {
  mergeComposerReferences,
  type ComposerCandidate,
  type ComposerReference,
} from '../../core/composerReferences'
import type { RecentItem, RecentKind } from '../../core/recentSkills'
import { connectorSections, type Connector } from '../../core/connectors'

/** 「＋ 带什么」里能带上的东西：技能、命令、连接器、Agent、工作流。 */
export type BringGroup = 'skill' | 'command' | 'connector' | 'agent' | 'workflow'
export const bringGroupOrder: BringGroup[] = ['skill', 'command', 'connector', 'agent', 'workflow']
/** 搜索结果里的分组名。 */
export const bringGroupTitle: Record<BringGroup, string> = {
  skill: '技能',
  command: '命令',
  connector: '连接器',
  agent: 'Agent',
  workflow: '工作流',
}
/** 半高底单入口行的名称。 */
export const bringEntryTitle: Record<BringGroup, string> = {
  skill: '技能',
  connector: '连接器',
  agent: 'Agent',
  workflow: '工作流',
  command: '斜杠命令',
}
/**
 * 入口行分两张卡，和桌面「＋」菜单的两组一致：
 * 给这次任务用的（技能、连接器）；其余的工具（Agent、工作流、斜杠命令）。
 */
export const bringEntryCards: BringGroup[][] = [
  ['skill', 'connector'],
  ['agent', 'workflow', 'command'],
]

export type BringItem = {
  /** 稳定标识：引用类用 `ref:种类:id`，纯文本类用 `组:名称`。 */
  key: string
  group: BringGroup
  /** 列表里的标题：`/review`、`@代码审查`、`飞书`。 */
  token: string
  name: string
  displayName?: string
  description: string
  /** 技能/插件引用：选中后成为输入框里的可移除胶囊。 */
  reference?: ComposerReference
  /** 命令、Agent、工作流：选中后把这段文字写进输入框。 */
  insertText?: string
  /** 现在不能选的原因（例如连接器还没授权）；同时作为行尾的状态标签。 */
  unavailable?: string
  /** 连接器的 logo：用连接器 id 在 connectorIconSources 里找。 */
  iconId?: string
  /** 连接器所在的段：已连接、需要处理、推荐、其余。 */
  section?: ConnectorSection
  /** 连接器状态点：绿是已连接，琥珀是需要处理。 */
  dot?: 'ok' | 'attn'
  /** 行尾标签的口气：琥珀（要处理）或灰（只是说明）。 */
  tone?: 'attn' | 'muted'
  /** 点不能选的行时给用户看的一句话。 */
  notice?: string
}

export type ConnectorSection = 'connected' | 'attention' | 'suggested' | 'rest'
export const connectorSectionTitle: Record<ConnectorSection, string> = {
  connected: '已连接',
  attention: '需要处理',
  suggested: '推荐',
  rest: '全部连接器',
}
export const connectorOnComputer = '在电脑上连接'

export const referenceKey = (reference: Pick<ComposerReference, 'kind' | 'id'>) =>
  `ref:${reference.kind}:${reference.id}`

export function bringItemFromReference(reference: ComposerReference, asSkill = false): BringItem {
  const isConnector = !asSkill && reference.kind === 'plugin' && !!reference.mcpServerNames?.length
  return {
    key: referenceKey(reference),
    group: isConnector ? 'connector' : 'skill',
    token: isConnector ? reference.displayName || reference.name : `@${reference.displayName || reference.name}`,
    name: reference.name,
    displayName: reference.displayName,
    description: reference.description,
    reference,
    ...(isConnector ? { section: 'connected' as const, dot: 'ok' as const } : {}),
  }
}

const commandText = (name: string) => `/${name.replace(/^\//, '')} `

/** 轻量档位只保留技能和斜杠命令。 */
export function candidateBringItems(candidates: ComposerCandidate[], options: { lean: boolean }): BringItem[] {
  const items: BringItem[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const item: BringItem = candidate.reference
      ? bringItemFromReference(candidate.reference)
      : {
          key: `command:${candidate.name}`,
          group: 'command',
          token: `/${candidate.name.replace(/^\//, '')}`,
          name: candidate.name,
          description: candidate.description,
          insertText: commandText(candidate.name),
        }
    if (seen.has(item.key)) continue
    if (options.lean && !(item.group === 'command' || item.reference?.kind === 'skill')) continue
    seen.add(item.key)
    items.push(item)
  }
  return items
}

/** 电脑上 `/api/agents` 返回的一项（只取用到的字段）。 */
export type ProbedAgent = { agentType: string; description?: string; isActive?: boolean }
export type ProbedWorkflow = { name: string; description?: string }

/** 探测接口的返回：取出某个字段里的数组；不是数组（接口不存在、被拦截后的错误体）就当作不可用。 */
export function probeList<T>(value: unknown, key: string): T[] | null {
  if (!value || typeof value !== 'object') return null
  const list = (value as Record<string, unknown>)[key]
  return Array.isArray(list) ? (list as T[]) : null
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)
const records = (list: unknown[]) =>
  list.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')

/** `/api/agents` 返回 `{ activeAgents, allAgents }`，列表里只用生效的那份。 */
export function normalizeAgents(value: unknown): ProbedAgent[] | null {
  const list = probeList<unknown>(value, 'activeAgents')
  if (!list) return null
  return records(list).flatMap((entry) => {
    const agentType = str(entry.agentType)
    if (!agentType) return []
    return [
      {
        agentType,
        description: str(entry.description),
        ...(typeof entry.isActive === 'boolean' ? { isActive: entry.isActive } : {}),
      },
    ]
  })
}

/** `/api/workflows` 返回 `{ workflows }`。 */
export function normalizeWorkflows(value: unknown): ProbedWorkflow[] | null {
  const list = probeList<unknown>(value, 'workflows')
  if (!list) return null
  return records(list).flatMap((entry) => {
    const name = str(entry.name)
    return name ? [{ name, description: str(entry.description) }] : []
  })
}

export function agentBringItems(agents: ProbedAgent[]): BringItem[] {
  return agents
    .filter((agent) => agent.isActive !== false && !!agent.agentType)
    .map((agent) => ({
      key: `agent:${agent.agentType}`,
      group: 'agent' as const,
      token: agent.agentType,
      name: agent.agentType,
      description: agent.description ?? '',
      insertText: `/agent ${agent.agentType} `,
    }))
}

export function workflowBringItems(workflows: ProbedWorkflow[]): BringItem[] {
  return workflows
    .filter((workflow) => !!workflow.name)
    .map((workflow) => ({
      key: `workflow:${workflow.name}`,
      group: 'workflow' as const,
      token: workflow.name,
      name: workflow.name,
      description: workflow.description ?? '',
      insertText: commandText(workflow.name),
    }))
}

/**
 * 连接器目录按桌面的四段排：已连接（有插件就能引用，没有就只展示）、
 * 需要处理（手机上不能授权，只提示）、推荐（手机上不能安装）、其余。
 */
export function connectorBringItems(connectors: Connector[], existing: BringItem[]): BringItem[] {
  const sections = connectorSections(connectors)
  const plugins = existing.filter((item) => item.reference?.kind === 'plugin')
  const title = (connector: Connector) => connector.displayName || connector.id
  const result: BringItem[] = []
  for (const connector of sections.connected) {
    const plugin = plugins.find((item) => item.reference?.id === connector.pluginId)
    if (plugin?.reference) {
      result.push({
        ...plugin,
        group: 'connector',
        iconId: connector.id,
        token: title(connector),
        description: plugin.description || connector.description || '',
        section: 'connected',
        dot: 'ok',
      })
    } else {
      result.push({
        key: `connector:${connector.id}`,
        group: 'connector',
        iconId: connector.id,
        token: title(connector),
        name: title(connector),
        description: connector.description ?? '',
        section: 'connected',
        dot: 'ok',
        unavailable: '在电脑上管理',
        tone: 'muted',
        notice: '这个连接器还不能在手机上引用，请在电脑上使用',
      })
    }
  }
  for (const connector of sections.attention) {
    const failed = connector.status === 'error'
    result.push({
      key: `connector:${connector.id}`,
      group: 'connector',
      iconId: connector.id,
      token: title(connector),
      name: title(connector),
      description: failed ? '连接出错' : '需要登录授权',
      section: 'attention',
      dot: 'attn',
      unavailable: failed ? '需处理' : '需授权',
      tone: 'attn',
      notice: failed ? '请在电脑上查看并处理' : '请在电脑上完成授权',
    })
  }
  const offline = (connector: Connector, section: 'suggested' | 'rest'): BringItem => ({
    key: `connector:${connector.id}`,
    group: 'connector',
    iconId: connector.id,
    token: title(connector),
    name: title(connector),
    description: connector.description ?? '',
    section,
    unavailable: connector.installed ? '在电脑上管理' : connectorOnComputer,
    tone: 'muted',
    notice: connector.installed ? '请在电脑上管理这个连接器' : '请在电脑上连接这个连接器',
  })
  for (const connector of sections.suggested) result.push(offline(connector, 'suggested'))
  for (const connector of sections.rest) result.push(offline(connector, 'rest'))
  return result
}

/** 合并各来源，同一个 key 只留第一次出现的那条（连接器目录的名称优先于插件原名）。 */
export function mergeBringItems(...groups: BringItem[][]): BringItem[] {
  const map = new Map<string, BringItem>()
  for (const item of groups.flat()) if (!map.has(item.key) || item.group === 'connector') map.set(item.key, item)
  return [...map.values()]
}

/** 三类要单独探测的目录；拿不到（旧电脑没有接口、网络出错）就是 null，对应入口不显示。 */
export type BringExtrasData = {
  agents: ProbedAgent[] | null
  connectors: Connector[] | null
  workflows: ProbedWorkflow[] | null
}

/**
 * 把技能/命令目录和三类探测结果合成一份。轻量档位只保留技能和斜杠命令。
 * 目录里「带 MCP 的插件」由连接器目录接管：没连上的退回技能（仍可搜到），连上的以连接器出现。
 */
export function assembleBringItems(input: {
  candidates: ComposerCandidate[]
  lean: boolean
  extras: BringExtrasData
}): BringItem[] {
  const base = candidateBringItems(input.candidates, { lean: input.lean })
  if (input.lean) return base
  const { connectors, agents, workflows } = input.extras
  const owned = new Set((connectors ?? []).map((connector) => connector.pluginId).filter(Boolean))
  const plugins = base.map((item) =>
    item.group === 'connector' && item.reference && owned.has(item.reference.id)
      ? bringItemFromReference(item.reference, true)
      : item
  )
  return mergeBringItems(
    plugins,
    connectors ? connectorBringItems(connectors, base) : [],
    agents ? agentBringItems(agents) : [],
    workflows ? workflowBringItems(workflows) : []
  )
}

export type BringEntry = { group: BringGroup; title: string; count: number }

/**
 * 半高底单的入口行，分两张卡。技能、命令没有就不显示；
 * 连接器、Agent、工作流只要探测成功就显示（连接器还有推荐可看）。
 * 数字是现成可用的个数：连接器数的是已连接的。
 */
export function bringEntries(
  items: BringItem[],
  probed: { connector: boolean; agent: boolean; workflow: boolean } = { connector: false, agent: false, workflow: false }
): BringEntry[][] {
  const count = (group: BringGroup) =>
    group === 'connector'
      ? items.filter((item) => item.group === 'connector' && item.section === 'connected').length
      : items.filter((item) => item.group === group).length
  const shown = (group: BringGroup) =>
    group === 'connector'
      ? probed.connector || items.some((item) => item.group === 'connector')
      : group === 'agent'
        ? probed.agent
        : group === 'workflow'
          ? probed.workflow
          : count(group) > 0
  return bringEntryCards
    .map((card) => card.filter(shown).map((group) => ({ group, title: bringEntryTitle[group], count: count(group) })))
    .filter((card) => card.length > 0)
}

export const groupItems = (items: BringItem[], group: BringGroup) => items.filter((item) => item.group === group)

/* ───────────── 搜索 ───────────── */

export type Range = [number, number]
export type BringHit = { item: BringItem; titleRanges: Range[]; descriptionRanges: Range[] }
export type BringResultGroup = { group: BringGroup; title: string; hits: BringHit[] }

const queryTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)

/** 所有关键词在文本里出现的位置，合并重叠后按起点排序。 */
export function matchRanges(text: string, query: string): Range[] {
  const terms = queryTerms(query)
  if (!terms.length || !text) return []
  const lower = text.toLowerCase()
  // 个别字符转小写会改变长度，位置就对不上了：这种文本不高亮。
  if (lower.length !== text.length) return []
  const found: Range[] = []
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(term, from)
      if (at < 0) break
      found.push([at, at + term.length])
      from = at + term.length
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Range[] = []
  for (const range of found) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return merged
}

/** 把文本按高亮区间切成片段，用来渲染。 */
export function splitByRanges(text: string, ranges: Range[]): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), hit: false })
    parts.push({ text: text.slice(start, end), hit: true })
    at = end
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts.length ? parts : [{ text, hit: false }]
}

const stripSigil = (text: string) => text.replace(/^[/@]/, '')

/**
 * 每个关键词都要出现在标题、名称或说明里；标题以关键词开头的排前，
 * 其次是标题包含，最后才是只有说明命中；同档保持目录里的顺序。
 */
export function searchBringItems(items: BringItem[], query: string): BringResultGroup[] {
  const terms = queryTerms(query)
  if (!terms.length) return []
  const hits: { hit: BringHit; rank: number; index: number }[] = []
  items.forEach((item, index) => {
    const title = `${item.token} ${item.name} ${item.displayName ?? ''}`.toLowerCase()
    const full = `${title} ${item.description.toLowerCase()}`
    if (!terms.every((term) => full.includes(term))) return
    const bare = stripSigil(item.token).toLowerCase()
    const rank = terms.every((term) => bare.startsWith(term))
      ? 0
      : terms.every((term) => title.includes(term))
        ? 1
        : 2
    hits.push({
      hit: {
        item,
        titleRanges: matchRanges(item.token, query),
        descriptionRanges: matchRanges(item.description, query),
      },
      rank,
      index,
    })
  })
  hits.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return bringGroupOrder
    .map((group) => ({
      group,
      title: bringGroupTitle[group],
      hits: hits.filter((value) => value.hit.item.group === group).map((value) => value.hit),
    }))
    .filter((value) => value.hits.length > 0)
}

/* ───────────── 选择 ───────────── */

export const isBringSelected = (selected: BringItem[], item: BringItem) =>
  selected.some((value) => value.key === item.key)

/** 点一下：没选就加到末尾，已选就取消。不能选的（还没授权）不改变选择。 */
export function toggleBringItem(selected: BringItem[], item: BringItem): BringItem[] {
  if (item.unavailable) return selected
  return isBringSelected(selected, item)
    ? selected.filter((value) => value.key !== item.key)
    : [...selected, item]
}

/** 打开时输入框里已有的技能胶囊算「已选」，可以在这里取消。 */
export const initialSelection = (references: ComposerReference[]): BringItem[] =>
  mergeComposerReferences(references).map((reference) => bringItemFromReference(reference))

export const doneLabel = (count: number) => (count > 0 ? `完成（${count}）` : '完成')

/** 底部「完成」只在有东西可确认时出现：二级页、搜索，或已经改动了选择。 */
export function showDone(input: { page: 'root' | 'list'; searching: boolean; selected: BringItem[]; initial: BringItem[] }) {
  const changed =
    input.selected.length !== input.initial.length ||
    input.selected.some((item) => !isBringSelected(input.initial, item))
  return input.page !== 'root' || input.searching || changed
}

/** 把一段文字接到草稿末尾，前面没有空白就补一个空格。 */
export function appendInsertText(draft: string, text: string) {
  const prefix = draft && !/\s$/.test(draft) ? ' ' : ''
  return `${draft}${prefix}${text}`
}

/**
 * 点「完成」：引用类以最终勾选为准（取消勾选的会从输入框移除）；
 * 命令、Agent、工作流只对新选的追加文字。返回新增的几项，用来记「最近用过」。
 */
export function applyBringSelection(input: {
  draft: string
  selected: BringItem[]
  initial: BringItem[]
}): { draft: string; references: ComposerReference[]; added: BringItem[] } {
  const added = input.selected.filter((item) => !isBringSelected(input.initial, item))
  const references = mergeComposerReferences(
    input.selected.flatMap((item) => (item.reference ? [item.reference] : []))
  )
  const draft = added.reduce(
    (text, item) => (item.insertText ? appendInsertText(text, item.insertText) : text),
    input.draft
  )
  return { draft, references, added }
}

/* ───────────── 最近用过 ───────────── */

export function toRecent(item: BringItem): Omit<RecentItem, 'usedAt'> {
  const kind: RecentKind = item.reference
    ? item.reference.kind
    : item.group === 'agent'
      ? 'agent'
      : item.group === 'workflow'
        ? 'workflow'
        : 'command'
  return { key: item.key, kind, name: item.name, displayName: item.displayName, description: item.description }
}

/** 只显示目录里仍然存在的、也能直接选的，最多几条。 */
export function resolveRecents(recents: RecentItem[], items: BringItem[], limit = 4): BringItem[] {
  const result: BringItem[] = []
  for (const recent of recents) {
    const item = items.find((value) => value.key === recent.key)
    if (item && !item.unavailable && !result.some((value) => value.key === item.key)) result.push(item)
    if (result.length >= limit) break
  }
  return result
}
