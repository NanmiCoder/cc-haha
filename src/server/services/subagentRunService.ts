import {
  sessionService,
  type MessageEntry,
  type MessageUsage,
  type SessionTaskNotification,
} from './sessionService.js'
import { workflowService } from './workflowService.js'

export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'
export type SubagentRunSource = 'subagent-jsonl' | 'session-history' | 'live-task' | 'none'

export type SubagentRunUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type SubagentRunResponse = {
  sessionId: string
  toolUseId: string
  agentId: string | null
  taskId?: string
  status: SubagentRunStatus
  description?: string
  prompt?: string
  summary?: string
  result?: string
  outputFile?: string
  usage?: SubagentRunUsage
  messages: MessageEntry[]
  /**
   * Complete, untruncated transcript projection used to rebuild Activity.
   *
   * Only sent when `truncated` is true — that is, only when it actually
   * differs from `messages`. Below the truncation threshold the two fields held
   * the same array, so every run payload shipped its contents twice (measured:
   * exactly 2× on a synthetic fixture). Clients already fall back to
   * `messages`, which is identical in that case.
   */
  activityMessages?: MessageEntry[]
  taskNotifications: SessionTaskNotification[]
  /** Notifications whose nested Agent ids match `activityMessages`. */
  activityTaskNotifications: SessionTaskNotification[]
  truncated: boolean
  historyComplete?: boolean
  activityComplete?: boolean
  updatedAt?: string
  source: SubagentRunSource
  /**
   * Whether a follow-up message can still reach this agent. A one-shot
   * subagent is dispatched, answers once, and is done — resuming it would
   * spawn a detached background copy whose output has nowhere to land, so the
   * client must not offer a composer for it. Named teammates and in-flight
   * background agents are the two cases that do have a live inbox.
   */
  canSendMessage: boolean
}

export type SubagentRunResolution = {
  agentId: string | null
  description?: string
  prompt?: string
  result?: string
  usage?: SubagentRunUsage
  updatedAt?: string
  hasResult: boolean
  isAsyncLaunch: boolean
  isError: boolean
}

type ContentBlock = {
  type?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  text?: unknown
  is_error?: unknown
}

type MessageEntryLike = {
  type?: string
  content?: unknown
  timestamp?: string
  usage?: MessageUsage
  message?: {
    role?: string
    content?: unknown
    usage?: MessageUsage
  }
}

type TruncateResult = {
  messages: MessageEntry[]
  truncated: boolean
}

/**
 * A resumed teammate rewrites its whole transcript each turn, so its fragments
 * form a chain where each one repeats its predecessor's messages. Deduplicating
 * by message id hides the repetition from the transcript, but activity scopes
 * every tool id to its own fragment: the surviving `tool_use` would keep the
 * first fragment's scope while a `tool_result` that only reached the rewrite
 * keeps the later one, and the pair stops matching. Dropping the superseded
 * fragments first keeps each call and its result inside one scope.
 *
 * Only a strict prefix counts as superseded, so independent resumes that reuse
 * message ids for different work are all preserved.
 */
export function dropSupersededTeammateFragments<T extends { messages: MessageEntry[] }>(
  fragments: T[],
): T[] {
  if (fragments.length < 2) return fragments
  const identities = fragments.map(fragment => (
    fragment.messages.map(message => JSON.stringify(message))
  ))
  return fragments.filter((_unused, index) => !identities.some((candidate, other) => (
    other !== index &&
    identities[index]!.length < candidate.length &&
    identities[index]!.every((identity, position) => identity === candidate[position])
  )))
}

export function mergeTeammateTranscriptFragments(
  fragments: Array<{ messages: MessageEntry[] }>,
): MessageEntry[] {
  const seenMessageIds = new Set<string>()
  const messages: MessageEntry[] = []

  for (const message of fragments.flatMap((fragment) => fragment.messages)) {
    if (seenMessageIds.has(message.id)) continue
    seenMessageIds.add(message.id)
    messages.push(message)
  }

  return messages.sort((left, right) => {
    const leftTime = Date.parse(left.timestamp)
    const rightTime = Date.parse(right.timestamp)
    return (Number.isFinite(leftTime) ? leftTime : 0) -
      (Number.isFinite(rightTime) ? rightTime : 0)
  })
}

export function mergeTeammateTranscriptTaskNotifications(
  fragments: Array<{ taskNotifications: SessionTaskNotification[] }>,
): SessionTaskNotification[] {
  const notifications = new Map<string, SessionTaskNotification>()
  for (const notification of fragments.flatMap((fragment) => fragment.taskNotifications)) {
    notifications.set(notification.toolUseId, notification)
  }
  return [...notifications.values()]
}

type ActivityProjection = {
  messages: MessageEntry[]
  taskNotifications: SessionTaskNotification[]
}

/**
 * Preserve the physical transcript fragment that owns a nested Agent call.
 *
 * A named teammate can be resumed into several `agent-<uuid>.jsonl` files and
 * Claude may reuse a leaf id such as `Agent:0` in every fragment. The desktop
 * already appends the row's tool id to its canonical nested route. Nested
 * Agent ids are always prefixed; when several resumed fragments are merged,
 * every tool id is prefixed so reused Bash/Todo/Task ids cannot pair across
 * fragments either.
 */
export function projectSubagentActivityFragment(
  fragment: {
    agentId: string
    messages: MessageEntry[]
    taskNotifications: SessionTaskNotification[]
  },
  options: { scopeAllToolIds?: boolean } = {},
): ActivityProjection {
  const scopedToolIds = new Map<string, string>()

  for (const message of fragment.messages) {
    for (const block of contentBlocks(message.content)) {
      if (
        block.type === 'tool_use' &&
        (block.name === 'Agent' || options.scopeAllToolIds === true) &&
        typeof block.id === 'string'
      ) {
        scopedToolIds.set(block.id, `${fragment.agentId}/${block.id}`)
      }
    }
  }

  if (scopedToolIds.size === 0) {
    return {
      messages: fragment.messages,
      taskNotifications: fragment.taskNotifications,
    }
  }

  const messages = fragment.messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((value) => {
      if (!isRecord(value)) return value
      if (
        value.type === 'tool_use' &&
        typeof value.id === 'string'
      ) {
        const scopedId = scopedToolIds.get(value.id)
        if (scopedId) {
          changed = true
          return { ...value, id: scopedId }
        }
      }
      if (value.type === 'tool_result' && typeof value.tool_use_id === 'string') {
        const scopedId = scopedToolIds.get(value.tool_use_id)
        if (scopedId) {
          changed = true
          return { ...value, tool_use_id: scopedId }
        }
      }
      return value
    })
    return changed ? { ...message, content } : message
  })

  return {
    messages,
    taskNotifications: fragment.taskNotifications.map((notification) => {
      const scopedId = scopedToolIds.get(notification.toolUseId)
      return scopedId ? { ...notification, toolUseId: scopedId } : notification
    }),
  }
}

function mergeTeammateActivityFragments(
  fragments: Array<{
    agentId: string
    messages: MessageEntry[]
    taskNotifications: SessionTaskNotification[]
  }>,
): ActivityProjection {
  const projected = dropSupersededTeammateFragments(fragments).map(fragment => (
    projectSubagentActivityFragment(fragment, { scopeAllToolIds: true })
  ))
  return {
    messages: mergeTeammateTranscriptFragments(projected),
    taskNotifications: mergeTeammateTranscriptTaskNotifications(projected),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function contentFromMessage(entry: MessageEntryLike): unknown {
  return entry.content ?? entry.message?.content
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter(isRecord) as ContentBlock[]
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (!isRecord(block)) return ''
      if (typeof block.text === 'string') return block.text
      if ('content' in block) return textFromContent(block.content)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractAgentId(text: string): string | null {
  return text.match(/(?:^|\n)\s*(?:agentId|agent_id):\s*([A-Za-z0-9_@.-]+)/)?.[1] ?? null
}

function normalizeAgentIdHint(value: string | undefined): string | undefined {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  return value
}

function normalizeToolUseIdHint(value: string | undefined): string | undefined {
  if (!value || value.length > 256 || value.includes('/')) return undefined
  return value
}

function normalizeCanonicalParentRef(value: string | undefined): string | undefined {
  if (!value || value.length > 256 || value.includes('/') || value.includes('\0')) {
    return undefined
  }
  return value
}

export type CanonicalNestedAgentToolRef = {
  parentAgentId: string
  leafToolUseId: string
}

/**
 * A nested Agent tool keeps the canonical path already used by joined session
 * history: `<parent tool ref>/<parent agent id>/<raw child tool id>`. When the
 * parent is still running, its messages have not yet been joined into the root
 * transcript, so the final two segments are the address needed to read that
 * parent's transcript directly.
 */
export function parseCanonicalNestedAgentToolRef(
  toolRef: string,
): CanonicalNestedAgentToolRef | null {
  const leafSeparator = toolRef.lastIndexOf('/')
  if (leafSeparator <= 0 || leafSeparator === toolRef.length - 1) return null
  const parentRef = toolRef.slice(0, leafSeparator)
  const parentSeparator = parentRef.lastIndexOf('/')
  if (parentSeparator <= 0 || parentSeparator === parentRef.length - 1) return null

  const parentAgentId = normalizeCanonicalParentRef(parentRef.slice(parentSeparator + 1))
  const leafToolUseId = normalizeToolUseIdHint(toolRef.slice(leafSeparator + 1))
  return parentAgentId && leafToolUseId
    ? { parentAgentId, leafToolUseId }
    : null
}

function isAsyncAgentLaunchResult(text: string): boolean {
  return text.includes('Async agent launched successfully.') &&
    text.includes('The agent is working in the background.')
}

function cleanedAgentResultText(text: string): string | undefined {
  const cleaned = text
    .replace(/<usage>[\s\S]*?<\/usage>/gi, '')
    .split('\n')
    .filter((line) => !/^\s*(?:agentId|agent_id):\s*[A-Za-z0-9_@.-]+/.test(line))
    .join('\n')
    .trim()

  return cleaned || undefined
}

function readNumberValue(text: string, keys: string[]): number | undefined {
  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tagMatch = text.match(new RegExp(`<${escapedKey}>\\s*(\\d+)\\s*<\\/${escapedKey}>`, 'i'))
    if (tagMatch?.[1]) return Number.parseInt(tagMatch[1], 10)

    const lineMatch = text.match(new RegExp(`(?:^|\\n)\\s*${escapedKey}\\s*[:=]\\s*(\\d+)`, 'i'))
    if (lineMatch?.[1]) return Number.parseInt(lineMatch[1], 10)
  }
  return undefined
}

function normalizeUsage(usage: SubagentRunUsage): SubagentRunUsage | undefined {
  const normalized: SubagentRunUsage = {}

  if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) {
    normalized.inputTokens = usage.inputTokens
  }
  if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
    normalized.outputTokens = usage.outputTokens
  }
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
    normalized.totalTokens = usage.totalTokens
  } else if (
    typeof normalized.inputTokens === 'number' &&
    typeof normalized.outputTokens === 'number'
  ) {
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function extractUsage(text: string): SubagentRunUsage | undefined {
  const usageText = text.match(/<usage>([\s\S]*?)<\/usage>/i)?.[1] ?? text
  return normalizeUsage({
    inputTokens: readNumberValue(usageText, ['input_tokens', 'inputTokens']),
    outputTokens: readNumberValue(usageText, ['output_tokens', 'outputTokens']),
    totalTokens: readNumberValue(usageText, ['total_tokens', 'totalTokens']),
  })
}

function mergeUsage(
  preferred: SubagentRunUsage | undefined,
  fallback: SubagentRunUsage | undefined,
): SubagentRunUsage | undefined {
  if (!preferred) return fallback
  if (!fallback) return preferred

  return normalizeUsage({
    inputTokens: preferred.inputTokens ?? fallback.inputTokens,
    outputTokens: preferred.outputTokens ?? fallback.outputTokens,
    totalTokens: preferred.totalTokens ?? fallback.totalTokens,
  })
}

function usageFromTranscriptMessages(messages: unknown[]): SubagentRunUsage | undefined {
  let inputTokens: number | undefined
  let outputTokens: number | undefined

  for (const message of messages) {
    if (!isRecord(message) || !isRecord(message.usage)) continue
    if (typeof message.usage.input_tokens === 'number') {
      inputTokens = (inputTokens ?? 0) + message.usage.input_tokens
    }
    if (typeof message.usage.output_tokens === 'number') {
      outputTokens = (outputTokens ?? 0) + message.usage.output_tokens
    }
  }

  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return normalizeUsage({ inputTokens, outputTokens })
}

function latestTimestamp(...values: Array<string | undefined>): string | undefined {
  let latest: string | undefined
  let latestMs = Number.NEGATIVE_INFINITY

  for (const value of values) {
    if (!value) continue
    const time = Date.parse(value)
    if (!Number.isFinite(time) || time < latestMs) continue
    latest = value
    latestMs = time
  }

  return latest
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function resolveSubagentRunFromMessages(
  messages: MessageEntryLike[],
  toolUseId: string,
): SubagentRunResolution | null {
  let foundAgentToolUse = false
  let description: string | undefined
  let prompt: string | undefined
  let agentId: string | null = null
  let result: string | undefined
  let usage: SubagentRunUsage | undefined
  let updatedAt: string | undefined
  let hasResult = false
  let isAsyncLaunch = false
  let isError = false

  for (const entry of messages) {
    for (const block of contentBlocks(contentFromMessage(entry))) {
      if (
        block.type === 'tool_use' &&
        block.name === 'Agent' &&
        block.id === toolUseId
      ) {
        foundAgentToolUse = true
        updatedAt = latestTimestamp(updatedAt, entry.timestamp)
        const input = isRecord(block.input) ? block.input : {}
        description = stringField(input.description) ?? description
        prompt = stringField(input.prompt) ?? prompt
      }

      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
        hasResult = true
        isError = block.is_error === true || isError
        updatedAt = latestTimestamp(updatedAt, entry.timestamp)
        const text = textFromContent(block.content)
        agentId = extractAgentId(text) ?? agentId
        isAsyncLaunch = isAsyncAgentLaunchResult(text) || isAsyncLaunch
        result = cleanedAgentResultText(text) ?? result
        usage = mergeUsage(extractUsage(text), usage)
      }
    }
  }

  if (!foundAgentToolUse) return null

  return {
    agentId,
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(result ? { result } : {}),
    ...(usage ? { usage } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    hasResult,
    isAsyncLaunch,
    isError,
  }
}

export function truncateSubagentMessages(messages: MessageEntry[]): TruncateResult {
  if (messages.length <= 1000) {
    return { messages, truncated: false }
  }

  return {
    messages: [...messages.slice(0, 50), ...messages.slice(-950)],
    truncated: true,
  }
}

function statusFromResolution(
  resolution: SubagentRunResolution,
  notification: SessionTaskNotification | undefined,
): SubagentRunStatus {
  if (resolution.isError) return 'failed'
  if (notification?.status) return notification.status
  if (resolution.hasResult && !resolution.isAsyncLaunch) return 'completed'
  return 'running'
}

async function resolveTranscript(
  sessionId: string,
  candidates: Array<string | null | undefined>,
): Promise<{
  agentId: string | null
  messages: MessageEntry[]
  taskNotifications: SessionTaskNotification[]
  historyComplete?: boolean
}> {
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const agentId = normalizeAgentIdHint(candidate ?? undefined)
    if (!agentId || seen.has(agentId)) continue
    seen.add(agentId)
    const transcript = await sessionService.getSubagentTranscript(sessionId, agentId, { bounded: true })
    if (transcript.messages.length > 0 || transcript.taskNotifications.length > 0 || transcript.historyComplete === false) {
      return { agentId, ...transcript }
    }
  }
  return { agentId: null, messages: [], taskNotifications: [] }
}

async function resolveRunFromToolRef(
  sessionId: string,
  rootMessages: MessageEntry[],
  toolRef: string,
  rootComplete = true,
): Promise<{
  historyComplete: boolean
  resolution: SubagentRunResolution
  lookupToolUseId: string
  expectedOwnerAgentId: string | null
} | null> {
  const unknownResolution: SubagentRunResolution = { agentId: null, hasResult: false, isAsyncLaunch: false, isError: false }
  const exactResolution = resolveSubagentRunFromMessages(rootMessages, toolRef)
  const nestedRef = parseCanonicalNestedAgentToolRef(toolRef)
  if (!nestedRef) {
    if (!exactResolution && rootComplete) return null
    return {
      historyComplete: rootComplete,
      resolution: exactResolution ?? unknownResolution,
      lookupToolUseId: toolRef,
      expectedOwnerAgentId: null,
    }
  }

  const strictParentAgentId = normalizeAgentIdHint(nestedRef.parentAgentId)
  if (strictParentAgentId) {
    if (exactResolution) {
      return {
        historyComplete: rootComplete,
        resolution: exactResolution,
        lookupToolUseId: nestedRef.leafToolUseId,
        expectedOwnerAgentId: strictParentAgentId,
      }
    }
    const parentTranscript = await sessionService.getSubagentTranscript(
      sessionId,
      strictParentAgentId,
      { bounded: true, toolUseId: nestedRef.leafToolUseId },
    )
    const nestedResolution = resolveSubagentRunFromMessages(
      parentTranscript.messages,
      nestedRef.leafToolUseId,
    )
    return nestedResolution || parentTranscript.historyComplete === false || !rootComplete
      ? {
          historyComplete: rootComplete && parentTranscript.historyComplete !== false,
          resolution: nestedResolution ?? unknownResolution,
          lookupToolUseId: nestedRef.leafToolUseId,
          expectedOwnerAgentId: strictParentAgentId,
        }
      : null
  }

  // Team member refs (`name@team`) are logical inbox identities, not the UUID
  // used for their transcript filename. Resolve the member name through the
  // launch metadata and prefer the newest resumed fragment containing the
  // addressed leaf Agent call.
  const teamSeparator = nestedRef.parentAgentId.lastIndexOf('@')
  if (teamSeparator <= 0 || teamSeparator === nestedRef.parentAgentId.length - 1) {
    return null
  }
  const teammateName = nestedRef.parentAgentId.slice(0, teamSeparator)
  const fragments = await sessionService.getSubagentTranscriptFragmentsByAgentType(
    sessionId,
    teammateName,
    { bounded: true, toolUseId: nestedRef.leafToolUseId },
  )
  for (let index = fragments.length - 1; index >= 0; index -= 1) {
    const fragment = fragments[index]!
    const nestedResolution = resolveSubagentRunFromMessages(
      fragment.messages,
      nestedRef.leafToolUseId,
    )
    if (nestedResolution) {
      return {
        historyComplete: rootComplete && fragments.every(fragment => fragment.historyComplete !== false),
        resolution: nestedResolution,
        lookupToolUseId: nestedRef.leafToolUseId,
        expectedOwnerAgentId: fragment.agentId,
      }
    }
  }
  return fragments.some(fragment => fragment.historyComplete === false) || !rootComplete
    ? { historyComplete: false, resolution: unknownResolution, lookupToolUseId: nestedRef.leafToolUseId, expectedOwnerAgentId: nestedRef.parentAgentId }
    : null
}

function notificationForToolRef(
  notifications: SessionTaskNotification[],
  toolUseId: string,
  expectedOwnerAgentId: string | null,
): SessionTaskNotification | undefined {
  const candidates = notifications.filter(candidate => candidate.toolUseId === toolUseId)
  const exact = candidates.filter(candidate => expectedOwnerAgentId === null
    ? candidate.ownerAgentId === undefined
    : candidate.ownerAgentId === expectedOwnerAgentId)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return undefined

  // Legacy task notifications did not persist ownerAgentId. They remain safe
  // only when this raw leaf occurs once across every owner in the session.
  if (
    expectedOwnerAgentId !== null &&
    candidates.length === 1 &&
    candidates[0]!.ownerAgentId === undefined
  ) {
    return candidates[0]
  }
  return undefined
}

/**
 * Read a subagent run straight from its transcript.
 *
 * {@link getSubagentRunByTool} starts from an `Agent` tool call in the parent
 * conversation, which is how an agent the assistant dispatched is found. A
 * workflow's agents are spawned by the workflow runtime instead, so no such
 * tool call exists and that lookup can never resolve them — but they are
 * ordinary subagents written by the same runner to the same place, so their
 * `agent-<id>.jsonl` is all that is needed.
 */
export async function getSubagentRunByAgentId(
  sessionId: string,
  agentId: string,
): Promise<SubagentRunResponse | null> {
  const normalized = normalizeAgentIdHint(agentId)
  if (!normalized) return null

  const transcript = await resolveTranscript(sessionId, [normalized])
  if (!transcript.agentId) return null

  const messages = transcript.messages
  const activity = projectSubagentActivityFragment({
    agentId: transcript.agentId,
    messages,
    taskNotifications: transcript.taskNotifications,
  })
  const truncated = truncateSubagentMessages(activity.messages)
  const usage = transcript.historyComplete === false ? undefined : usageFromTranscriptMessages(messages)
  const updatedAt = latestTimestamp(
    ...messages.map(message =>
      isRecord(message) && typeof message.timestamp === 'string'
        ? message.timestamp
        : undefined,
    ),
    ...transcript.taskNotifications.map(notification => notification.timestamp),
  )
  const workflowState = await workflowService
    .getAgentRunState(sessionId, transcript.agentId)
    .catch(() => null)
  const status: SubagentRunStatus = workflowState
    ? workflowState.agent.state === 'done'
      ? 'completed'
      : workflowState.run.status === 'stopped'
        ? 'stopped'
        : workflowState.agent.state === 'error' || workflowState.run.status === 'failed'
          ? 'failed'
          : 'running'
    : transcript.historyComplete === false ? 'unknown' : 'completed'

  return {
    sessionId,
    // The caller addressed this run by agent id; echoing it keeps the response
    // self-describing without inventing a tool call that never happened.
    toolUseId: normalized,
    agentId: transcript.agentId,
    status,
    ...(usage ? { usage } : {}),
    messages: truncated.messages,
    ...(truncated.truncated ? { activityMessages: activity.messages } : {}),
    taskNotifications: transcript.taskNotifications,
    activityTaskNotifications: activity.taskNotifications,
    truncated: truncated.truncated || transcript.historyComplete === false,
    historyComplete: transcript.historyComplete !== false,
    activityComplete: transcript.historyComplete !== false,
    ...(updatedAt ? { updatedAt } : {}),
    source: 'subagent-jsonl',
    // A workflow agent answers once into its script and is gone; there is no
    // inbox a follow-up could reach.
    canSendMessage: false,
  }
}

export async function getSubagentRunByTool(
  sessionId: string,
  toolUseId: string,
  liveTaskId?: string,
): Promise<SubagentRunResponse | null> {
  // Only the root-level `Agent` tool call is resolved here — its child
  // transcript is read separately below. Pulling the merged view instead would
  // re-materialize every linked subagent on each card open.
  const parentLookup = await sessionService.getSubagentRunLookup(sessionId, toolUseId)
  const { messages: parentMessages, taskNotifications } = parentLookup
  const resolvedToolRef = await resolveRunFromToolRef(sessionId, parentMessages, toolUseId, parentLookup.historyComplete !== false)
  if (!resolvedToolRef) return null
  const { resolution, lookupToolUseId, expectedOwnerAgentId } = resolvedToolRef

  const notification = notificationForToolRef(
    taskNotifications,
    lookupToolUseId,
    expectedOwnerAgentId,
  )
  const safeLiveTaskId = normalizeAgentIdHint(liveTaskId)
  const teammateName = resolution.agentId?.includes('@')
    ? resolution.agentId.split('@')[0]
    : undefined
  const teammateFragments = teammateName
    ? await sessionService.getSubagentTranscriptFragmentsByAgentType(sessionId, teammateName, { bounded: true })
    : []
  // Sidecar metadata is written before the agent starts, so it is the only
  // hint that exists while the run is still streaming. The other candidates
  // are all recovered from the completion result.
  const metadataAgentId = normalizeAgentIdHint(
    (await sessionService.findSubagentAgentIdByToolUseId(
      sessionId,
      lookupToolUseId,
      expectedOwnerAgentId,
    )) ?? undefined,
  )
  const transcript = teammateFragments.length > 0
    ? {
        historyComplete: teammateFragments.every(fragment => fragment.historyComplete !== false),
        agentId: teammateFragments[teammateFragments.length - 1]!.agentId,
        messages: mergeTeammateTranscriptFragments(teammateFragments),
        taskNotifications: mergeTeammateTranscriptTaskNotifications(teammateFragments),
      }
    : await resolveTranscript(sessionId, [
        metadataAgentId,
        resolution.agentId,
        safeLiveTaskId,
        notification?.taskId,
      ])
  const activity = teammateFragments.length > 0
    ? mergeTeammateActivityFragments(teammateFragments)
    : transcript.agentId
      ? projectSubagentActivityFragment({
          agentId: transcript.agentId,
          messages: transcript.messages,
          taskNotifications: transcript.taskNotifications,
        })
      : {
          messages: transcript.messages,
          taskNotifications: transcript.taskNotifications,
        }
  const historyComplete = resolvedToolRef.historyComplete && transcript.historyComplete !== false
  const status = !resolvedToolRef.historyComplete && !resolution.hasResult && !notification?.status
    ? 'unknown' : statusFromResolution(resolution, notification)
  const resolvedAgentId = transcript.agentId
    ?? metadataAgentId
    ?? normalizeAgentIdHint(resolution.agentId ?? undefined)
    ?? null
  // An async launch acknowledges immediately, so `isAsyncLaunch` is already
  // true while that agent runs — which is exactly the window where queuing a
  // follow-up works. A synchronous subagent only produces its tool_result at
  // the very end, so it never qualifies.
  const canSendMessage = Boolean(resolvedAgentId) && (
    Boolean(teammateName) || (resolution.isAsyncLaunch && status === 'running')
  )
  const transcriptMessages = transcript.messages
  const truncated = truncateSubagentMessages(activity.messages)
  const transcriptUsage = transcript.historyComplete === false ? undefined : usageFromTranscriptMessages(transcriptMessages)
  const usage = mergeUsage(resolution.usage, transcriptUsage)
  const latestTranscriptTimestamp = latestTimestamp(
    ...transcriptMessages.map((message) => (
      isRecord(message) && typeof message.timestamp === 'string'
        ? message.timestamp
        : undefined
    )),
    ...transcript.taskNotifications.map(taskNotification => taskNotification.timestamp),
  )

  return {
    sessionId,
    toolUseId,
    agentId: resolvedAgentId,
    ...(notification?.taskId || safeLiveTaskId
      ? { taskId: notification?.taskId || safeLiveTaskId }
      : {}),
    status,
    ...(resolution.description ? { description: resolution.description } : {}),
    ...(resolution.prompt ? { prompt: resolution.prompt } : {}),
    ...(notification?.summary ? { summary: notification.summary } : {}),
    ...(notification?.result || resolution.result
      ? { result: notification?.result || resolution.result }
      : {}),
    ...(notification?.outputFile ? { outputFile: notification.outputFile } : {}),
    ...(usage ? { usage } : {}),
    messages: truncated.messages,
    ...(truncated.truncated ? { activityMessages: activity.messages } : {}),
    taskNotifications: transcript.taskNotifications,
    activityTaskNotifications: activity.taskNotifications,
    truncated: truncated.truncated || !historyComplete,
    historyComplete,
    activityComplete: historyComplete,
    ...(latestTimestamp(resolution.updatedAt, notification?.timestamp, latestTranscriptTimestamp)
      ? { updatedAt: latestTimestamp(resolution.updatedAt, notification?.timestamp, latestTranscriptTimestamp) }
      : {}),
    source: transcriptMessages.length > 0
      ? 'subagent-jsonl'
      : safeLiveTaskId
        ? 'live-task'
        : 'session-history',
    canSendMessage,
  }
}
