import {
  sessionService,
  type MessageEntry,
  type MessageUsage,
  type SessionLaunchInfo,
  type SessionTaskNotification,
} from './sessionService.js'
import { conversationService } from './conversationService.js'
import {
  ANTIGRAVITY_PROVIDER_ID,
  isSafeAntigravityId,
  readAntigravityParentSubagentSpawns,
  readAntigravitySubagentRegistry,
  readAntigravityTranscript,
  type AntigravitySubagentRecord,
} from './antigravityTranscriptAdapter.js'
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
  /** The model that served the run's newest answer. Absent until it answers. */
  model?: string
  /**
   * Effort level the run launched with, from its metadata sidecar. `null`
   * means the model's own default; absent when the sidecar predates it.
   */
  effort?: string | null
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
  role?: string
  typeName?: string
  isAntigravitySubagent?: boolean
  antigravitySpawnOrdinal?: number
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
  return text.match(/(?:^|\n)\s*(?:agentId|agent_id|conversationId|conversation_id):\s*([A-Za-z0-9_@.-]+)/)?.[1]
    ?? text.match(/"(?:conversationId|conversation_id)"\s*:\s*"([A-Za-z0-9_-]+)"/)?.[1]
    ?? null
}

function isAntigravitySubagentToolName(name: unknown): boolean {
  return name === 'invoke_subagent' || name === 'Antigravity: Run invoke_subagent'
}

function extractChildIdFromAntigravityToolRef(toolRef: string): string | null {
  const colonIdx = toolRef.indexOf(':call_')
  if (colonIdx <= 0) return null
  const prefix = toolRef.slice(0, colonIdx)
  return isSafeAntigravityId(prefix) ? prefix : null
}

type AntigravitySessionHint = {
  isAntigravity: boolean
  nativeSessionId?: string
}

async function readAntigravitySessionHint(sessionId: string): Promise<AntigravitySessionHint> {
  if (typeof sessionService.getSessionLaunchInfo !== 'function') {
    return { isAntigravity: false }
  }
  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
  if (!launchInfo) return { isAntigravity: false }
  const isAntigravity = launchInfo.runtimeProviderId === ANTIGRAVITY_PROVIDER_ID
  const extended = launchInfo as SessionLaunchInfo & {
    nativeSessionId?: unknown
    antigravitySessionId?: unknown
  }
  const rawNativeId = typeof extended.nativeSessionId === 'string' && extended.nativeSessionId.trim()
    ? extended.nativeSessionId.trim()
    : typeof extended.antigravitySessionId === 'string' && extended.antigravitySessionId.trim()
      ? extended.antigravitySessionId.trim()
      : undefined
  return {
    isAntigravity,
    ...(rawNativeId && isSafeAntigravityId(rawNativeId) ? { nativeSessionId: rawNativeId } : {}),
  }
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
  return (
    (text.includes('Async agent launched successfully.') &&
      text.includes('The agent is working in the background.')) ||
    text.includes('Created the following subagent:')
  )
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

// The CLI's placeholder for messages it made up itself (interrupts, errors).
const SYNTHETIC_MODEL = '<synthetic>'

/**
 * The model behind the newest answer. Assistant messages carry whatever the
 * provider actually served, which is the only record of the model a run that
 * inherited its parent's resolved to.
 */
function latestServedModel(messages: MessageEntry[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.model
    if (typeof model === 'string' && model && model !== SYNTHETIC_MODEL) return model
  }
  return undefined
}

async function recordedRunEffort(
  sessionId: string,
  agentId: string | null,
): Promise<{ effort?: string | null }> {
  if (!agentId) return {}
  const metadata = await sessionService.getSubagentMetadata(sessionId, agentId)
  if (!isRecord(metadata)) return {}
  if (metadata.effort === null) return { effort: null }
  return typeof metadata.effort === 'string' && /^[a-z]{1,16}$/.test(metadata.effort)
    ? { effort: metadata.effort }
    : {}
}

function runRuntimeFields(
  messages: MessageEntry[],
  recorded: { effort?: string | null },
): Pick<SubagentRunResponse, 'model' | 'effort'> {
  const model = latestServedModel(messages)
  return { ...(model ? { model } : {}), ...recorded }
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
  let role: string | undefined
  let typeName: string | undefined
  let isAntigravitySubagent = false
  let antigravitySpawnOrdinal: number | undefined
  const seenSpawnsByKey = new Map<string, number>()

  for (const entry of messages) {
    for (const block of contentBlocks(contentFromMessage(entry))) {
      const isAgyTool = block.type === 'tool_use' && isAntigravitySubagentToolName(block.name)
      const isStandardAgentTool = block.type === 'tool_use' && block.name === 'Agent'
      if (isAgyTool || isStandardAgentTool) {
        const input = isRecord(block.input) ? block.input : {}
        const inputRole = stringField(input.Role) ?? stringField(input.role)
        const inputTypeName = stringField(input.TypeName) ?? stringField(input.typeName)
        const isAgyMarked = isAgyTool || input.antigravityToolName === 'invoke_subagent' || Boolean(inputTypeName)
        const spawnKey = `${inputTypeName ?? ''}\u0000${inputRole ?? ''}`
        if (block.id !== toolUseId) {
          if (isAgyMarked) {
            seenSpawnsByKey.set(spawnKey, (seenSpawnsByKey.get(spawnKey) ?? 0) + 1)
          }
        } else {
          foundAgentToolUse = true
          updatedAt = latestTimestamp(updatedAt, entry.timestamp)
          const inputConvId = stringField(input.conversationId)
            ?? stringField(input.conversation_id)
            ?? stringField(input.agentId)
            ?? stringField(input.agent_id)
          if (inputRole) role = inputRole
          if (inputTypeName) typeName = inputTypeName
          if (inputConvId && !agentId) agentId = inputConvId
          if (isAgyMarked || inputConvId) {
            isAntigravitySubagent = true
            antigravitySpawnOrdinal = seenSpawnsByKey.get(spawnKey) ?? 0
          }
          description = stringField(input.description)
            ?? inputRole
            ?? inputTypeName
            ?? description
          prompt = stringField(input.prompt)
            ?? stringField(input.Prompt)
            ?? prompt
        }
      }

      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
        hasResult = true
        isError = block.is_error === true || isError
        updatedAt = latestTimestamp(updatedAt, entry.timestamp)
        const text = textFromContent(block.content)
        const extracted = extractAgentId(text)
        if (extracted) {
          agentId = extracted
          if (/"(?:conversationId|conversation_id)"/.test(text) || /conversationId\s*:/.test(text)) {
            isAntigravitySubagent = true
          }
        }
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
    ...(role ? { role } : {}),
    ...(typeName ? { typeName } : {}),
    ...(isAntigravitySubagent ? { isAntigravitySubagent: true } : {}),
    ...(antigravitySpawnOrdinal !== undefined ? { antigravitySpawnOrdinal } : {}),
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
  signal?: AbortSignal,
): Promise<{
  agentId: string | null
  messages: MessageEntry[]
  taskNotifications: SessionTaskNotification[]
  historyComplete?: boolean
}> {
  const seen = new Set<string>()
  for (const candidate of candidates) {
    signal?.throwIfAborted()
    const agentId = normalizeAgentIdHint(candidate ?? undefined)
    if (!agentId || seen.has(agentId)) continue
    seen.add(agentId)
    const transcript = await sessionService.getSubagentTranscript(sessionId, agentId, { bounded: true, signal })
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
  signal?: AbortSignal,
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
      { bounded: true, toolUseId: nestedRef.leafToolUseId, signal },
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
    { bounded: true, toolUseId: nestedRef.leafToolUseId, signal },
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

function deriveAntigravitySubagentStatus(
  resolution: SubagentRunResolution | null,
  notification: SessionTaskNotification | undefined,
  transcriptStatus: 'running' | 'completed' | 'failed' | 'unknown',
  hasFinalResult: boolean,
  registryState: string | undefined,
  lastStepIsToolError = false,
): SubagentRunStatus {
  if (resolution?.isError) return 'failed'
  if (notification?.status) return notification.status
  if (transcriptStatus === 'failed') {
    // A mid-run tool error (GENERIC ERROR) while the subagent is still ALIVE
    // is recoverable on the next planner turn; do not lock the run as failed.
    if (lastStepIsToolError && registryState === 'SUBAGENT_STATE_ALIVE') return 'running'
    return 'failed'
  }
  if (transcriptStatus === 'running') return 'running'
  if (transcriptStatus === 'completed' && hasFinalResult) return 'completed'
  if (registryState === 'SUBAGENT_STATE_KILLED') return 'stopped'
  if (registryState === 'SUBAGENT_STATE_ALIVE') return 'running'
  if (resolution?.hasResult && !resolution.isAsyncLaunch) return 'completed'
  if (transcriptStatus === 'completed') return 'completed'
  return 'unknown'
}

async function resolveAntigravityChildFromParent(
  nativeSessionId: string,
  resolution: SubagentRunResolution,
  options: { appDataDir?: string; signal?: AbortSignal },
): Promise<{ conversationId: string | null; registryRecord?: AntigravitySubagentRecord }> {
  const registry = await readAntigravitySubagentRegistry(nativeSessionId, options)
  const nonSwarmRecords = registry.filter(
    (record) => !(record.typeName === 'worker' && record.role?.startsWith('Swarm Worker')),
  )
  const candidates = nonSwarmRecords.length > 0 ? nonSwarmRecords : registry

  // 1. Check parent Antigravity transcript.jsonl for exact prompt / role / typeName match
  const spawns = await readAntigravityParentSubagentSpawns(nativeSessionId, options)
  if (spawns.length > 0) {
    const ordinal = resolution.antigravitySpawnOrdinal ?? 0
    const matchingPromptSpawns = resolution.prompt
      ? spawns.filter((spawn) => spawn.prompt === resolution.prompt)
      : []
    const exactPrompt = matchingPromptSpawns.length > 0
      ? (matchingPromptSpawns[ordinal] ?? matchingPromptSpawns[0])
      : undefined
    if (exactPrompt) {
      return {
        conversationId: exactPrompt.conversationId,
        registryRecord: registry.find((r) => r.conversationId === exactPrompt.conversationId),
      }
    }
    const matchingSpawns = spawns.filter((spawn) => (
      (!resolution.role || spawn.role === resolution.role)
      && (!resolution.typeName || spawn.typeName === resolution.typeName)
    ))
    const pickedSpawn = matchingSpawns[ordinal] ?? matchingSpawns[0]
    if (pickedSpawn) {
      return {
        conversationId: pickedSpawn.conversationId,
        registryRecord: registry.find((r) => r.conversationId === pickedSpawn.conversationId),
      }
    }
  }

  // 2. Match against authoritative .system_generated/subagents/*.json registry
  if (candidates.length > 0) {
    const byRoleAndType = candidates.filter((record) => (
      (!resolution.role || record.role === resolution.role)
      && (!resolution.typeName || record.typeName === resolution.typeName)
    ))
    const ordinal = resolution.antigravitySpawnOrdinal ?? 0
    if (byRoleAndType.length > 0) {
      const picked = byRoleAndType[ordinal] ?? byRoleAndType[0]!
      return { conversationId: picked.conversationId, registryRecord: picked }
    }
    if (resolution.typeName) {
      const byType = candidates.filter((record) => record.typeName === resolution.typeName)
      if (byType.length > 0) {
        const picked = byType[ordinal] ?? byType[0]!
        return { conversationId: picked.conversationId, registryRecord: picked }
      }
    }
    if (candidates.length === 1) {
      return { conversationId: candidates[0]!.conversationId, registryRecord: candidates[0] }
    }
  }

  return { conversationId: null }
}

async function buildAntigravitySubagentResponse(params: {
  sessionId: string
  toolUseId: string
  conversationId: string | null
  resolution: SubagentRunResolution | null
  notification?: SessionTaskNotification
  safeLiveTaskId?: string
  registryRecord?: AntigravitySubagentRecord
  rootHistoryComplete: boolean
  appDataDir?: string
  signal?: AbortSignal
}): Promise<SubagentRunResponse | null> {
  const {
    sessionId,
    toolUseId,
    conversationId,
    resolution,
    notification,
    safeLiveTaskId,
    registryRecord,
    rootHistoryComplete,
    appDataDir,
    signal,
  } = params

  const transcript = conversationId
    ? await readAntigravityTranscript(conversationId, { appDataDir, signal })
    : null

  if (!resolution && !transcript?.exists && !registryRecord) {
    return null
  }

  const transcriptMessages = transcript?.messages ?? []
  const activity = conversationId && transcriptMessages.length > 0
    ? projectSubagentActivityFragment({
        agentId: conversationId,
        messages: transcriptMessages,
        taskNotifications: [],
      })
    : { messages: transcriptMessages, taskNotifications: [] }
  const truncated = truncateSubagentMessages(activity.messages)
  const historyComplete = rootHistoryComplete && (transcript?.historyComplete !== false)
  const transcriptUsage = transcript?.usage
    ? normalizeUsage({
        inputTokens: transcript.usage.inputTokens,
        outputTokens: transcript.usage.outputTokens,
        totalTokens: transcript.usage.totalTokens,
      })
    : undefined
  const usage = mergeUsage(resolution?.usage, transcriptUsage)
  const status = deriveAntigravitySubagentStatus(
    resolution,
    notification,
    transcript?.status ?? 'unknown',
    Boolean(transcript?.finalResult),
    registryRecord?.state,
    transcript?.lastStepIsToolError === true,
  )
  const updatedAt = latestTimestamp(
    resolution?.updatedAt,
    notification?.timestamp,
    transcript?.updatedAt,
  )
  const model = transcript?.model ?? latestServedModel(transcriptMessages)
  const description = resolution?.description
    ?? registryRecord?.role
    ?? registryRecord?.typeName
  const result = notification?.result
    ?? (resolution?.isAsyncLaunch ? undefined : resolution?.result)
    ?? transcript?.finalResult

  return {
    sessionId,
    toolUseId,
    agentId: conversationId,
    ...(notification?.taskId || safeLiveTaskId
      ? { taskId: notification?.taskId || safeLiveTaskId }
      : {}),
    status,
    ...(description ? { description } : {}),
    ...(resolution?.prompt ? { prompt: resolution.prompt } : {}),
    ...(notification?.summary ? { summary: notification.summary } : {}),
    ...(result ? { result } : {}),
    ...(notification?.outputFile ? { outputFile: notification.outputFile } : {}),
    ...(usage ? { usage } : {}),
    messages: truncated.messages,
    ...(truncated.truncated ? { activityMessages: activity.messages } : {}),
    taskNotifications: [],
    activityTaskNotifications: activity.taskNotifications,
    truncated: truncated.truncated || !historyComplete || (transcript?.truncated === true),
    historyComplete,
    activityComplete: historyComplete,
    ...(updatedAt ? { updatedAt } : {}),
    source: transcript?.exists && transcriptMessages.length > 0
      ? 'subagent-jsonl'
      : safeLiveTaskId
        ? 'live-task'
        : 'session-history',
    ...(model ? { model } : {}),
    ...(transcript?.effort ? { effort: transcript.effort } : {}),
    canSendMessage: false,
  }
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
  options: { signal?: AbortSignal; appDataDir?: string } = {},
): Promise<SubagentRunResponse | null> {
  const signal = options.signal
  signal?.throwIfAborted()
  const normalized = normalizeAgentIdHint(agentId)
  if (!normalized) return null

  const antigravityHint = await readAntigravitySessionHint(sessionId)
  if (antigravityHint.isAntigravity) {
    const registry = antigravityHint.nativeSessionId
      ? await readAntigravitySubagentRegistry(antigravityHint.nativeSessionId, {
          appDataDir: options.appDataDir,
          signal,
        })
      : []
    const registryRecord = registry.find((record) => record.conversationId === normalized)
    return buildAntigravitySubagentResponse({
      sessionId,
      toolUseId: normalized,
      conversationId: normalized,
      resolution: null,
      registryRecord,
      rootHistoryComplete: true,
      appDataDir: options.appDataDir,
      signal,
    })
  }

  const transcript = await resolveTranscript(sessionId, [normalized], signal)
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
    ...runRuntimeFields(messages, await recordedRunEffort(sessionId, transcript.agentId)),
    // A workflow agent answers once into its script and is gone; there is no
    // inbox a follow-up could reach.
    canSendMessage: false,
  }
}

function countPriorAntigravitySiblingSpawns(
  liveMessages: MessageEntryLike[],
  toolUseId: string,
  spawnKey: string,
  diskPriorIds?: string[],
): number {
  const priorIds = new Set<string>()
  for (const id of diskPriorIds ?? []) {
    if (id !== toolUseId) priorIds.add(id)
  }
  for (const entry of liveMessages) {
    for (const block of contentBlocks(contentFromMessage(entry))) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue
      if (block.id === toolUseId) return priorIds.size
      const isAgyTool = isAntigravitySubagentToolName(block.name)
      const isStandardAgentTool = block.name === 'Agent'
      if (!isAgyTool && !isStandardAgentTool) continue
      const input = isRecord(block.input) ? block.input : {}
      const inputTypeName = stringField(input.TypeName) ?? stringField(input.typeName)
      const inputRole = stringField(input.Role) ?? stringField(input.role)
      const isAgyMarked = isAgyTool || input.antigravityToolName === 'invoke_subagent' || Boolean(inputTypeName)
      if (!isAgyMarked) continue
      const key = `${inputTypeName ?? ''}\u0000${inputRole ?? ''}`
      if (key === spawnKey) priorIds.add(block.id)
    }
  }
  return priorIds.size
}

export async function getSubagentRunByTool(
  sessionId: string,
  toolUseId: string,
  liveTaskId?: string,
  options: { signal?: AbortSignal; appDataDir?: string } = {},
): Promise<SubagentRunResponse | null> {
  const signal = options.signal
  signal?.throwIfAborted()
  // Only the root-level `Agent` tool call is resolved here — its child
  // transcript is read separately below. Pulling the merged view instead would
  // re-materialize every linked subagent on each card open.
  const parentLookup = await sessionService.getSubagentRunLookup(sessionId, toolUseId, undefined, signal)
  const { messages: parentMessages, taskNotifications } = parentLookup
  let resolvedToolRef = await resolveRunFromToolRef(sessionId, parentMessages, toolUseId, parentLookup.historyComplete !== false, signal)
  const antigravityHint = await readAntigravitySessionHint(sessionId)
  const childIdFromToolRef = extractChildIdFromAntigravityToolRef(toolUseId)
  if (resolvedToolRef && parentLookup.antigravitySpawnOrdinal !== undefined) {
    resolvedToolRef = {
      ...resolvedToolRef,
      resolution: {
        ...resolvedToolRef.resolution,
        antigravitySpawnOrdinal: parentLookup.antigravitySpawnOrdinal,
      },
    }
  }
  if (!resolvedToolRef && antigravityHint.isAntigravity && typeof conversationService.getRecentSdkMessages === 'function') {
    const liveMessages = conversationService.getRecentSdkMessages(sessionId) as MessageEntryLike[]
    if (liveMessages.length > 0) {
      const liveResolution = resolveSubagentRunFromMessages(liveMessages, toolUseId)
      if (liveResolution) {
        const spawnKey = `${liveResolution.typeName ?? ''}\u0000${liveResolution.role ?? ''}`
        const ordinal = countPriorAntigravitySiblingSpawns(
          liveMessages,
          toolUseId,
          spawnKey,
          parentLookup.antigravitySpawnsByKey?.[spawnKey],
        )
        resolvedToolRef = {
          historyComplete: parentLookup.historyComplete !== false,
          resolution: {
            ...liveResolution,
            isAntigravitySubagent: true,
            antigravitySpawnOrdinal: ordinal,
          },
          lookupToolUseId: toolUseId,
          expectedOwnerAgentId: null,
        }
      }
    }
  }
  if (!resolvedToolRef) {
    if (antigravityHint.isAntigravity && childIdFromToolRef) {
      const registry = antigravityHint.nativeSessionId
        ? await readAntigravitySubagentRegistry(antigravityHint.nativeSessionId, {
            appDataDir: options.appDataDir,
            signal,
          })
        : []
      return buildAntigravitySubagentResponse({
        sessionId,
        toolUseId,
        conversationId: childIdFromToolRef,
        resolution: null,
        safeLiveTaskId: normalizeAgentIdHint(liveTaskId),
        registryRecord: registry.find((record) => record.conversationId === childIdFromToolRef),
        rootHistoryComplete: parentLookup.historyComplete !== false,
        appDataDir: options.appDataDir,
        signal,
      })
    }
    return null
  }
  const { resolution, lookupToolUseId, expectedOwnerAgentId } = resolvedToolRef

  const notification = notificationForToolRef(
    taskNotifications,
    lookupToolUseId,
    expectedOwnerAgentId,
  )
  const safeLiveTaskId = normalizeAgentIdHint(liveTaskId)

  if (antigravityHint.isAntigravity || resolution.isAntigravitySubagent) {
    const directCandidates = [
      resolution.agentId,
      childIdFromToolRef,
      safeLiveTaskId && safeLiveTaskId !== toolUseId ? safeLiveTaskId : undefined,
      notification?.taskId && notification.taskId !== toolUseId ? notification.taskId : undefined,
    ]
    let childConversationId: string | null = directCandidates.find(
      (candidate): candidate is string => isSafeAntigravityId(candidate),
    ) ?? null
    let registryRecord: AntigravitySubagentRecord | undefined

    if (antigravityHint.nativeSessionId) {
      if (childConversationId) {
        const registry = await readAntigravitySubagentRegistry(antigravityHint.nativeSessionId, {
          appDataDir: options.appDataDir,
          signal,
        })
        registryRecord = registry.find((record) => record.conversationId === childConversationId)
      } else {
        const discovered = await resolveAntigravityChildFromParent(
          antigravityHint.nativeSessionId,
          resolution,
          { appDataDir: options.appDataDir, signal },
        )
        childConversationId = discovered.conversationId
        registryRecord = discovered.registryRecord
      }
    }

    return buildAntigravitySubagentResponse({
      sessionId,
      toolUseId,
      conversationId: childConversationId,
      resolution,
      notification,
      safeLiveTaskId,
      registryRecord,
      rootHistoryComplete: resolvedToolRef.historyComplete,
      appDataDir: options.appDataDir,
      signal,
    })
  }
  const teammateName = resolution.agentId?.includes('@')
    ? resolution.agentId.split('@')[0]
    : undefined
  const teammateFragments = teammateName
    ? await sessionService.getSubagentTranscriptFragmentsByAgentType(sessionId, teammateName, { bounded: true, signal })
    : []
  let transcript = teammateFragments.length > 0
    ? {
        historyComplete: teammateFragments.every(fragment => fragment.historyComplete !== false),
        agentId: teammateFragments[teammateFragments.length - 1]!.agentId,
        messages: mergeTeammateTranscriptFragments(teammateFragments),
        taskNotifications: mergeTeammateTranscriptTaskNotifications(teammateFragments),
      }
    : await resolveTranscript(
        sessionId,
        [resolution.agentId, safeLiveTaskId, notification?.taskId],
        signal,
      )
  // Sidecar metadata is written before the agent starts, so it is the only
  // hint that exists while the run is still streaming. Skip the full directory
  // scan once direct candidates or teammate fragments already resolved a run.
  const metadataAgentId = transcript.agentId
    ? undefined
    : normalizeAgentIdHint(
        (await sessionService.findSubagentAgentIdByToolUseId(
          sessionId,
          lookupToolUseId,
          expectedOwnerAgentId,
          signal,
        )) ?? undefined,
      )
  if (!transcript.agentId && metadataAgentId) {
    transcript = await resolveTranscript(sessionId, [metadataAgentId], signal)
  }
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
    ...runRuntimeFields(transcriptMessages, await recordedRunEffort(sessionId, resolvedAgentId)),
    canSendMessage,
  }
}
