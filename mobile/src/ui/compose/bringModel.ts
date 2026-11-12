import {
  mergeComposerReferences,
  type ComposerCandidate,
  type ComposerReference,
} from '../../core/composerReferences'
import type { RecentItem, RecentKind } from '../../core/recentSkills'
import { connectorSections, type Connector } from '../../core/connectors'

/** Things that can be brought in "+ Bring": skills, commands, connectors, agents, workflows. */
export type BringGroup = 'skill' | 'command' | 'connector' | 'agent' | 'workflow'
export const bringGroupOrder: BringGroup[] = ['skill', 'command', 'connector', 'agent', 'workflow']
/** Group name in search results. */
export const bringGroupTitle: Record<BringGroup, string> = {
  skill: 'Skills',
  command: 'Commands',
  connector: 'Connectors',
  agent: 'Agent',
  workflow: 'Workflows',
}
/** Name of the entry row in the half-height sheet. */
export const bringEntryTitle: Record<BringGroup, string> = {
  skill: 'Skills',
  connector: 'Connectors',
  agent: 'Agent',
  workflow: 'Workflows',
  command: 'Slash commands',
}
/**
 * Entry rows are split into two cards, matching the two groups in the desktop "+" menu: 
 * For this task (skills, connectors); the other tools (agents, workflows, slash commands).
 */
export const bringEntryCards: BringGroup[][] = [
  ['skill', 'connector'],
  ['agent', 'workflow', 'command'],
]

export type BringItem = {
  /** Stable ID: references use `ref:kind:id`, plain text items use `group:name`. */
  key: string
  group: BringGroup
  /** Title in the list: `/review`, `@code-review`, `Feishu`. */
  token: string
  name: string
  displayName?: string
  description: string
  /** Skill/plugin references: once selected they become removable capsules in the input. */
  reference?: ComposerReference
  /** Commands, agents, workflows: once selected, write this text into the input. */
  insertText?: string
  /** Reason it cannot be selected now (e.g. connector not authorized yet); also used as the status label at the row end. */
  unavailable?: string
  /** Connector logo: looked up in connectorIconSources by connector id. */
  iconId?: string
  /** Section of the connector: connected, needs attention, recommended, rest. */
  section?: ConnectorSection
  /** Connector status dot: green is connected, amber needs attention. */
  dot?: 'ok' | 'attn'
  /** Tone of the row-end label: amber (needs action) or grey (informational only). */
  tone?: 'attn' | 'muted'
  /** One line shown to the user when tapping an unselectable row. */
  notice?: string
}

export type ConnectorSection = 'connected' | 'attention' | 'suggested' | 'rest'
export const connectorSectionTitle: Record<ConnectorSection, string> = {
  connected: 'Connected',
  attention: 'Needs attention',
  suggested: 'Recommended',
  rest: 'All connectors',
}
export const connectorOnComputer = 'Connect on the computer'

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

/** The light tier keeps only skills and slash commands. */
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

/** One item returned by `/api/agents` on the computer (only the fields used). */
export type ProbedAgent = { agentType: string; description?: string; isActive?: boolean }
export type ProbedWorkflow = { name: string; description?: string }

/** Probe endpoint response: take the array from a field; anything not an array (missing endpoint, error body after being blocked) counts as unavailable. */
export function probeList<T>(value: unknown, key: string): T[] | null {
  if (!value || typeof value !== 'object') return null
  const list = (value as Record<string, unknown>)[key]
  return Array.isArray(list) ? (list as T[]) : null
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)
const records = (list: unknown[]) =>
  list.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')

/** `/api/agents` Returns `{ activeAgents, allAgents }`; the list only uses the active one. */
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

/** `/api/workflows` Returns `{ workflows }`. */
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
 * The connectors directory is ordered in the four desktop sections: connected (referenceable if it has a plugin, otherwise display only), 
 * needs attention (cannot authorize on the phone, hint only), recommended (cannot install on the phone), rest.
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
        unavailable: 'Manage on the computer',
        tone: 'muted',
        notice: 'This connector cannot be referenced on the phone yet; please use it on the computer',
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
      description: failed ? 'Connection error' : 'Sign-in authorization needed',
      section: 'attention',
      dot: 'attn',
      unavailable: failed ? 'Needs attention' : 'Needs auth',
      tone: 'attn',
      notice: failed ? 'Please view and handle it on the computer' : 'Please complete authorization on the computer',
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
    unavailable: connector.installed ? 'Manage on the computer' : connectorOnComputer,
    tone: 'muted',
    notice: connector.installed ? 'Please manage this connector on the computer' : 'Please connect this connector on the computer',
  })
  for (const connector of sections.suggested) result.push(offline(connector, 'suggested'))
  for (const connector of sections.rest) result.push(offline(connector, 'rest'))
  return result
}

/** Merge all sources, keeping only the first entry per key (connector directory names win over raw plugin names). */
export function mergeBringItems(...groups: BringItem[][]): BringItem[] {
  const map = new Map<string, BringItem>()
  for (const item of groups.flat()) if (!map.has(item.key) || item.group === 'connector') map.set(item.key, item)
  return [...map.values()]
}

/** Three directories probed separately; unavailable (old computer without endpoint, network error) is null, and the corresponding entry is hidden. */
export type BringExtrasData = {
  agents: ProbedAgent[] | null
  connectors: Connector[] | null
  workflows: ProbedWorkflow[] | null
}

/**
 * Combine the skill/command directory with the three probe results. The light tier keeps only skills and slash commands.
 * "Plugins with MCP" in the directory are taken over by the connectors directory: unconnected ones fall back to skills (still searchable), connected ones appear as connectors.
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
 * Entry rows of the half-height sheet, in two cards. Skills and commands are hidden when empty; 
 * connectors, agents and workflows show whenever the probe succeeds (connectors also have recommendations to view).
 * Numbers are counts ready to use: for connectors it counts connected ones.
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

/* ───────────── Search ───────────── */

export type Range = [number, number]
export type BringHit = { item: BringItem; titleRanges: Range[]; descriptionRanges: Range[] }
export type BringResultGroup = { group: BringGroup; title: string; hits: BringHit[] }

const queryTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)

/** Positions of all keywords in the text, overlaps merged and sorted by start. */
export function matchRanges(text: string, query: string): Range[] {
  const terms = queryTerms(query)
  if (!terms.length || !text) return []
  const lower = text.toLowerCase()
  // Lowercasing some characters changes length so positions no longer line up: such text is not highlighted.
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

/** Split text into pieces by highlight ranges for rendering. */
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
 * Every keyword must appear in the title, name or description; titles starting with the keyword come first, 
 * then titles containing it, and finally description-only matches; within a tier keep directory order.
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

/* ───────────── Selection ───────────── */

export const isBringSelected = (selected: BringItem[], item: BringItem) =>
  selected.some((value) => value.key === item.key)

/** Tap: add to the end if not selected, deselect if selected. Unselectable ones (not authorized yet) do not change the selection. */
export function toggleBringItem(selected: BringItem[], item: BringItem): BringItem[] {
  if (item.unavailable) return selected
  return isBringSelected(selected, item)
    ? selected.filter((value) => value.key !== item.key)
    : [...selected, item]
}

/** Skill capsules already in the input when opened count as "selected" and can be deselected here. */
export const initialSelection = (references: ComposerReference[]): BringItem[] =>
  mergeComposerReferences(references).map((reference) => bringItemFromReference(reference))

export const doneLabel = (count: number) => (count > 0 ? `Done (${count})` : 'Done')

/** The bottom Done only appears when there is something to confirm: subpage, search, or the selection has changed. */
export function showDone(input: { page: 'root' | 'list'; searching: boolean; selected: BringItem[]; initial: BringItem[] }) {
  const changed =
    input.selected.length !== input.initial.length ||
    input.selected.some((item) => !isBringSelected(input.initial, item))
  return input.page !== 'root' || input.searching || changed
}

/** Append text to the end of the draft, adding a space if there is no whitespace before it. */
export function appendInsertText(draft: string, text: string) {
  const prefix = draft && !/\s$/.test(draft) ? ' ' : ''
  return `${draft}${prefix}${text}`
}

/**
 * Tap Done: references follow the final checks (unchecked ones are removed from the input); 
 * commands, agents and workflows append text only for newly selected ones. Returns the added items to record "Recently used".
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

/* ───────────── Recently used ───────────── */

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

/** Show only items still in the directory and directly selectable, at most a few. */
export function resolveRecents(recents: RecentItem[], items: BringItem[], limit = 4): BringItem[] {
  const result: BringItem[] = []
  for (const recent of recents) {
    const item = items.find((value) => value.key === recent.key)
    if (item && !item.unavailable && !result.some((value) => value.key === item.key)) result.push(item)
    if (result.length >= limit) break
  }
  return result
}
