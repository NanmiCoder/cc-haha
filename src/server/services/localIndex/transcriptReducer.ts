import { createSessionProtocolAccumulator } from '../sessionProtocolHistory.js'
import { cleanSessionTitleSource } from '../../../utils/sessionTitleText.js'
import { SYNTHETIC_MODEL } from '../../../utils/messages.js'
import { extractShotCountFromAssistantContent } from '../../../utils/shotStats.js'
import { normalizeDriveRootPathForPlatform } from '../windowsDrivePath.js'
import {
  activeGapMs,
  estimateCostUSD,
  isBillableUsageRecord,
  usageRecordKey,
} from '../../../utils/usageAccounting.js'
import type {
  ActivityDailyProjection,
  ActivityModelProjection,
  ActivityNamedUsageProjection,
  PersistedRepositorySession,
  PersistedWorktreeSession,
  SessionListSummary,
  TranscriptChunk,
  TranscriptEntryLocator,
  TranscriptProjection,
} from './types.js'

export const LOCAL_INDEX_REBUILD_REQUIRED = 'LOCAL_INDEX_REBUILD_REQUIRED'

export class TranscriptRebuildRequiredError extends Error {
  readonly code = LOCAL_INDEX_REBUILD_REQUIRED

  constructor() {
    super('Transcript projection state is unavailable; rebuild this source from byte zero')
    this.name = 'TranscriptRebuildRequiredError'
  }
}

type ReducerUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  server_tool_use?: {
    web_search_requests?: number
  }
  speed?: string
  iterations?: unknown
}

type ReducerEntry = {
  type?: string
  subtype?: string
  content?: unknown
  isMeta?: boolean
  cwd?: string
  timestamp?: string
  customTitle?: unknown
  aiTitle?: unknown
  permissionMode?: unknown
  requestId?: unknown
  version?: unknown
  sessionId?: unknown
  worktreeSession?: PersistedWorktreeSession | null
  message?: {
    id?: unknown
    role?: string
    content?: unknown
    model?: string
    usage?: ReducerUsage
  }
  [key: string]: unknown
}

type ReducerState = {
  fallbackCreatedAt: string
  fallbackModifiedAt: string
  fallbackWorkDir: string | null
  createdAt: string
  hasCreatedAt: boolean
  semanticModifiedAt: string | null
  messageCount: number
  firstUserTitle: string | null
  goalTitle: string | null
  aiTitle: string | null
  customTitle: string | null
  latestWorkDir: string | null
  latestCwd: string | null
  permissionMode: string | undefined
  runtimeProviderId: string | null | undefined
  runtimeModelId: string | undefined
  effortLevel: string | undefined
  sessionProtocol: ReturnType<typeof createSessionProtocolAccumulator>
  repository: PersistedRepositorySession | undefined
  worktreeSession: PersistedWorktreeSession | null | undefined
  nextOrdinal: number
  nextJsonlLine: number
  activityIsSubagent: boolean
  activitySawMessage: boolean
  activityFirstTimestampValid: boolean
  activityLastTimestampValid: boolean
  activityFirstTimestamp: string | null
  activityLastTimestamp: string | null
  activityLastMessageTime: number | null
  activityActiveDurationMs: number
  activityMessageCount: number
  activityStartHour: number | null
  activitySpeculationTimeSavedMs: number
  activityShotCount: number | null
  activityDaily: Map<string, ActivityDailyProjection>
  activityModels: Map<string, ActivityModelProjection>
  activityTools: Map<string, ActivityNamedUsageProjection>
  activitySkills: Map<string, ActivityNamedUsageProjection>
  // (message.id, requestId) pairs whose usage has already been counted for this source. Claude
  // Code writes one JSONL line per content block of an assistant message — a turn with thinking,
  // text and 12 tool_use blocks is 14 lines — and every one of them repeats the same complete
  // `usage` object. Without this the tokens of a single reply get counted once per block; on real
  // transcripts that inflated the total by 2.2x. Lives only in memory alongside the projection
  // Maps: a full re-read starts empty (correct), and an incremental read clones it forward.
  activityUsageKeys: Set<string>
}

export type TranscriptReductionOptions = {
  isSubagent?: boolean
}

const projectionStates = new WeakMap<TranscriptProjection, ReducerState>()

const VALID_SESSION_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
])
const VALID_SESSION_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const ACTIVITY_TRANSCRIPT_MESSAGE_TYPES = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
])

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function readXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match?.[1] ? decodeXmlText(match[1].trim()) : undefined
}

export function extractGoalCreationTitle(entry: ReducerEntry): string | null {
  if (
    entry.type !== 'system' ||
    entry.subtype !== 'local_command' ||
    typeof entry.content !== 'string'
  ) {
    return null
  }

  const commandName = readXmlTag(entry.content, 'command-name')?.replace(/^\//, '')
  if (commandName !== 'goal') return null

  const args = readXmlTag(entry.content, 'command-args')?.trim()
  if (!args || /^clear\b/i.test(args)) return null

  const title = cleanSessionTitleSource(`/goal ${args}`)
  return title ? title.length > 80 ? `${title.slice(0, 80)}...` : title : null
}

export function extractTranscriptUserTitle(content: unknown): string | null {
  let text: string | undefined
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const textBlock = content.find(
      (block: Record<string, unknown>) => block.type === 'text' && typeof block.text === 'string',
    )
    if (textBlock) text = textBlock.text as string
  }
  if (!text) return null

  const title = cleanSessionTitleSource(text)
  if (!title) return null
  return title.length > 80 ? `${title.slice(0, 80)}...` : title
}

function latestTimestamp(current: string | null, candidate: unknown): string | null {
  if (typeof candidate !== 'string') return current
  const candidateTime = Date.parse(candidate)
  if (!Number.isFinite(candidateTime)) return current
  if (!current) return candidate
  const currentTime = Date.parse(current)
  return !Number.isFinite(currentTime) || candidateTime > currentTime
    ? candidate
    : current
}

function cloneState(state: ReducerState): ReducerState {
  return {
    ...state,
    sessionProtocol: state.sessionProtocol.clone(),
    repository: state.repository ? { ...state.repository } : undefined,
    worktreeSession: state.worktreeSession
      ? { ...state.worktreeSession }
      : state.worktreeSession,
    activityDaily: new Map(
      [...state.activityDaily].map(([key, value]) => [key, { ...value }]),
    ),
    activityModels: new Map(
      [...state.activityModels].map(([key, value]) => [key, { ...value }]),
    ),
    activityTools: new Map(
      [...state.activityTools].map(([key, value]) => [key, { ...value }]),
    ),
    activitySkills: new Map(
      [...state.activitySkills].map(([key, value]) => [key, { ...value }]),
    ),
    activityUsageKeys: new Set(state.activityUsageKeys),
  }
}

function createInitialState(
  seed?: TranscriptProjection,
  options: TranscriptReductionOptions = {},
): ReducerState {
  const summary = seed?.summary
  const activity = seed?.activity
  return {
    fallbackCreatedAt: summary?.createdAt ?? '',
    fallbackModifiedAt: summary?.modifiedAt ?? '',
    fallbackWorkDir: summary?.workDir ?? null,
    createdAt: summary?.createdAt ?? '',
    hasCreatedAt: false,
    semanticModifiedAt: null,
    messageCount: 0,
    firstUserTitle: null,
    goalTitle: null,
    aiTitle: null,
    customTitle: null,
    latestWorkDir: null,
    latestCwd: null,
    permissionMode: undefined,
    runtimeProviderId: undefined,
    runtimeModelId: undefined,
    effortLevel: undefined,
    sessionProtocol: createSessionProtocolAccumulator(),
    repository: undefined,
    worktreeSession: undefined,
    nextOrdinal: 0,
    nextJsonlLine: 1,
    activityIsSubagent: options.isSubagent ?? activity?.isSubagent ?? false,
    activitySawMessage: activity?.firstTimestamp !== null && activity?.firstTimestamp !== undefined,
    activityFirstTimestampValid: activity?.firstTimestamp !== null && activity?.firstTimestamp !== undefined,
    activityLastTimestampValid: activity?.lastTimestamp !== null && activity?.lastTimestamp !== undefined,
    activityFirstTimestamp: activity?.firstTimestamp ?? null,
    activityLastTimestamp: activity?.lastTimestamp ?? null,
    activityLastMessageTime: parseTimestampMs(activity?.lastTimestamp),
    activityActiveDurationMs: activity?.activeDurationMs ?? 0,
    activityMessageCount: activity?.messageCount ?? 0,
    activityStartHour: activity?.startHour ?? null,
    activitySpeculationTimeSavedMs: activity?.speculationTimeSavedMs ?? 0,
    activityShotCount: activity?.shotCount ?? null,
    activityDaily: new Map(
      (activity?.daily ?? []).map(day => [day.date, { ...day }]),
    ),
    activityModels: new Map(
      (activity?.models ?? []).map(model => [
        `${model.date}\0${model.model}`,
        { ...model },
      ]),
    ),
    activityTools: new Map(
      (activity?.tools ?? []).map(tool => [
        `${tool.date}\0${tool.name}`,
        { ...tool },
      ]),
    ),
    activitySkills: new Map(
      (activity?.skills ?? []).map(skill => [
        `${skill.date}\0${skill.name}`,
        { ...skill },
      ]),
    ),
    activityUsageKeys: new Set(),
  }
}

function parseTimestampMs(timestamp: string | null | undefined): number | null {
  if (typeof timestamp !== 'string') return null
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : null
}

function activityDateKey(timestamp: unknown): { date: string; time: number } | null {
  if (typeof timestamp !== 'string') return null
  const parsed = new Date(timestamp)
  const time = parsed.getTime()
  if (!Number.isFinite(time)) return null
  return { date: parsed.toISOString().slice(0, 10), time }
}

function incrementNamedActivity(
  values: Map<string, ActivityNamedUsageProjection>,
  date: string,
  name: unknown,
): void {
  if (typeof name !== 'string') return
  const normalized = name.trim()
  if (!normalized) return
  const key = `${date}\0${normalized}`
  const existing = values.get(key)
  if (existing) existing.count += 1
  else values.set(key, { date, name: normalized, count: 1 })
}

function usageIdentity(entry: ReducerEntry) {
  return {
    version: entry.version,
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    messageId: entry.message?.id,
    forkedFrom: entry.forkedFrom,
  }
}

/**
 * Claim this usage record, returning false when its key was already counted — i.e. this line is
 * another content block of a reply already accounted for.
 */
function claimUsageRecord(state: ReducerState, entry: ReducerEntry, suffix = ''): boolean {
  const key = usageRecordKey(usageIdentity(entry), suffix)
  if (key === null) return true
  if (state.activityUsageKeys.has(key)) return false
  state.activityUsageKeys.add(key)
  return true
}

function cacheCreationTokens(usage: ReducerUsage): number {
  const split = usage.cache_creation
  if (split) {
    return (split.ephemeral_5m_input_tokens ?? 0) + (split.ephemeral_1h_input_tokens ?? 0)
  }
  return usage.cache_creation_input_tokens ?? 0
}

function accumulateUsage(
  state: ReducerState,
  date: string,
  model: string,
  usage: ReducerUsage,
): void {
  const key = `${date}\0${model}`
  let aggregate = state.activityModels.get(key)
  if (!aggregate) {
    aggregate = {
      date,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
    }
    state.activityModels.set(key, aggregate)
  }
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0
  const cacheCreationInputTokens = cacheCreationTokens(usage)
  const webSearchRequests = usage.server_tool_use?.web_search_requests ?? 0

  aggregate.inputTokens += inputTokens
  aggregate.outputTokens += outputTokens
  aggregate.cacheReadInputTokens += cacheReadInputTokens
  aggregate.cacheCreationInputTokens += cacheCreationInputTokens
  aggregate.webSearchRequests += webSearchRequests

  // A model we have no published rates for (every third-party provider) contributes tokens but no
  // dollars — see modelPricing.ts for why a null must never be folded in as a zero.
  const cost = estimateCostUSD(
    model,
    {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      webSearchRequests,
    },
    usage.speed,
  )
  if (cost !== null) aggregate.costUSD += cost
}

/**
 * Nested advisor work rides along in `usage.iterations` under its own model. Only
 * `advisor_message` iterations become separate records — the other iteration types are already
 * represented by the parent's totals, so counting them would double-bill the same turn.
 */
function accumulateAdvisorUsage(
  state: ReducerState,
  entry: ReducerEntry,
  date: string,
  usage: ReducerUsage,
): void {
  if (!Array.isArray(usage.iterations)) return
  let advisorIndex = 0
  for (const iteration of usage.iterations) {
    if (!iteration || typeof iteration !== 'object') continue
    const record = iteration as { type?: unknown; model?: unknown } & ReducerUsage
    if (record.type !== 'advisor_message') continue
    if (typeof record.model !== 'string' || !record.model) continue
    // Index before claiming, so a repeated content-block line maps its Nth advisor onto the same
    // key as the first line's Nth advisor rather than shifting by the number already claimed.
    const index = advisorIndex
    advisorIndex += 1
    if (!claimUsageRecord(state, entry, `\0advisor:${index}`)) continue
    accumulateUsage(state, date, record.model, record)
  }
}

function applyActivityEntry(state: ReducerState, entry: ReducerEntry): void {
  if (entry.type === 'speculation-accept') {
    const timeSavedMs = (entry as Record<string, unknown>).timeSavedMs
    if (typeof timeSavedMs === 'number' && Number.isFinite(timeSavedMs)) {
      state.activitySpeculationTimeSavedMs += timeSavedMs
    }
    return
  }

  // Canonical stats inspect shot attribution before excluding main-transcript
  // sidechains, then retain only the first match in each source.
  if (state.activityShotCount === null && entry.type === 'assistant') {
    state.activityShotCount = extractShotCountFromAssistantContent(entry.message?.content)
  }

  if (
    !entry.type ||
    !ACTIVITY_TRANSCRIPT_MESSAGE_TYPES.has(entry.type) ||
    (!state.activityIsSubagent && entry.isSidechain === true)
  ) {
    return
  }
  const timestamp = activityDateKey(entry.timestamp)
  if (!state.activitySawMessage) {
    state.activitySawMessage = true
    state.activityFirstTimestampValid = timestamp !== null
    state.activityFirstTimestamp = timestamp ? entry.timestamp! : null
    state.activityStartHour = timestamp ? new Date(entry.timestamp!).getHours() : null
  }
  state.activityLastTimestampValid = timestamp !== null
  state.activityLastTimestamp = timestamp ? entry.timestamp! : null
  state.activityMessageCount += 1
  if (timestamp) {
    state.activityActiveDurationMs += activeGapMs(state.activityLastMessageTime, timestamp.time)
    state.activityLastMessageTime = timestamp.time
  }
  if (!timestamp) return

  let daily = state.activityDaily.get(timestamp.date)
  if (!daily) {
    daily = { date: timestamp.date, messageCount: 0, toolCallCount: 0 }
    state.activityDaily.set(timestamp.date, daily)
  }
  if (!state.activityIsSubagent) daily.messageCount += 1

  if (entry.type !== 'assistant') return
  const content = entry.message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_use') {
        continue
      }
      daily.toolCallCount += 1
      const tool = block as { name?: unknown; input?: unknown }
      incrementNamedActivity(state.activityTools, timestamp.date, tool.name)
      if (
        tool.name === 'Skill' &&
        tool.input &&
        typeof tool.input === 'object' &&
        typeof (tool.input as { skill?: unknown }).skill === 'string'
      ) {
        incrementNamedActivity(
          state.activitySkills,
          timestamp.date,
          (tool.input as { skill: string }).skill,
        )
      }
    }
  }

  const usage = entry.message?.usage
  const model = entry.message?.model || 'unknown'
  if (!usage || model === SYNTHETIC_MODEL) return
  if (!isBillableUsageRecord(usageIdentity(entry))) return
  // Every content-block line of this reply carries the same usage; bill only the first one.
  if (!claimUsageRecord(state, entry)) return
  accumulateUsage(state, timestamp.date, model, usage)
  accumulateAdvisorUsage(state, entry, timestamp.date, usage)
}

function applyEntry(state: ReducerState, entry: ReducerEntry): void {
  state.sessionProtocol.add(entry)
  applyActivityEntry(state, entry)
  if (!state.hasCreatedAt && entry.timestamp) {
    state.createdAt = entry.timestamp
    state.hasCreatedAt = true
  }

  if (
    (entry.type === 'user' || entry.type === 'assistant') &&
    entry.message?.role
  ) {
    state.messageCount += 1
    if (!entry.isMeta) {
      state.semanticModifiedAt = latestTimestamp(
        state.semanticModifiedAt,
        entry.timestamp,
      )
    }
  }

  const record = entry as Record<string, unknown>
  if (entry.type === 'session-meta') {
    if (typeof record.workDir === 'string') {
      state.latestWorkDir = normalizeDriveRootPathForPlatform(record.workDir)
    }
    if (
      typeof entry.permissionMode === 'string' &&
      VALID_SESSION_PERMISSION_MODES.has(entry.permissionMode)
    ) {
      state.permissionMode = entry.permissionMode
    }
    if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
      state.runtimeProviderId = record.runtimeProviderId as string | null
    }
    if (typeof record.runtimeModelId === 'string') {
      state.runtimeModelId = record.runtimeModelId
    }
    if (
      typeof record.effortLevel === 'string' &&
      VALID_SESSION_EFFORT_LEVELS.has(record.effortLevel)
    ) {
      state.effortLevel = record.effortLevel
    }
  }

  if (typeof entry.cwd === 'string' && entry.cwd.trim()) {
    state.latestCwd = normalizeDriveRootPathForPlatform(entry.cwd)
  }

  const candidateRepository = record.repository
  if (candidateRepository && typeof candidateRepository === 'object') {
    state.repository = candidateRepository as PersistedRepositorySession
  }

  if (entry.type === 'worktree-state') {
    if (entry.worktreeSession === null) {
      state.worktreeSession = null
    } else if (
      entry.worktreeSession &&
      typeof entry.worktreeSession === 'object' &&
      typeof entry.worktreeSession.worktreePath === 'string' &&
      typeof entry.worktreeSession.worktreeName === 'string'
    ) {
      state.worktreeSession = entry.worktreeSession
    }
  }

  if (entry.type === 'custom-title' && entry.customTitle) {
    state.customTitle = String(entry.customTitle)
  }

  if (!state.goalTitle) {
    state.goalTitle = extractGoalCreationTitle(entry)
  }

  if (entry.type === 'ai-title' && entry.aiTitle) {
    const title = cleanSessionTitleSource(String(entry.aiTitle))
    if (title) state.aiTitle = title
  }

  if (
    !state.firstUserTitle &&
    entry.type === 'user' &&
    !entry.isMeta &&
    entry.message?.role === 'user'
  ) {
    state.firstUserTitle = extractTranscriptUserTitle(entry.message.content)
  }
}

function summaryFromState(state: ReducerState): SessionListSummary {
  return {
    title: state.customTitle ||
      state.goalTitle ||
      state.aiTitle ||
      state.firstUserTitle ||
      'Untitled Session',
    createdAt: state.hasCreatedAt ? state.createdAt : state.fallbackCreatedAt,
    modifiedAt: state.semanticModifiedAt ?? state.fallbackModifiedAt,
    messageCount: state.messageCount,
    workDir: state.latestWorkDir || state.latestCwd || state.fallbackWorkDir,
    ...(state.permissionMode ? { permissionMode: state.permissionMode } : {}),
    ...(state.runtimeProviderId !== undefined
      ? { runtimeProviderId: state.runtimeProviderId }
      : {}),
    ...(state.runtimeModelId ? { runtimeModelId: state.runtimeModelId } : {}),
    ...(state.effortLevel ? { effortLevel: state.effortLevel } : {}),
    ...(state.sessionProtocol.get() ? { sessionApiFormat: state.sessionProtocol.get() } : {}),
    ...(state.repository ? { repository: { ...state.repository } } : {}),
    ...(state.worktreeSession !== undefined
      ? {
          worktreeSession: state.worktreeSession
            ? { ...state.worktreeSession }
            : state.worktreeSession,
        }
      : {}),
  }
}

function cloneProjection(projection: TranscriptProjection): TranscriptProjection {
  return {
    ...projection,
    summary: {
      ...projection.summary,
      repository: projection.summary.repository
        ? { ...projection.summary.repository }
        : undefined,
      worktreeSession: projection.summary.worktreeSession
        ? { ...projection.summary.worktreeSession }
        : projection.summary.worktreeSession,
    },
    activity: projection.activity
      ? {
          ...projection.activity,
          daily: projection.activity.daily.map(value => ({ ...value })),
          models: projection.activity.models.map(value => ({ ...value })),
          tools: projection.activity.tools.map(value => ({ ...value })),
          skills: projection.activity.skills.map(value => ({ ...value })),
        }
      : undefined,
  }
}

export function reduceTranscript(
  chunks: Iterable<TranscriptChunk>,
  seed?: TranscriptProjection,
  options?: TranscriptReductionOptions,
): TranscriptProjection {
  return reduceTranscriptWithLocators(chunks, seed, options).projection
}

function chunkByteLength(chunk: TranscriptChunk): number {
  return chunk.byteLength ?? Buffer.byteLength(chunk.text)
}

function locatorFromEntry(
  entry: ReducerEntry,
  chunk: TranscriptChunk,
  state: ReducerState,
  jsonlLine: number,
): TranscriptEntryLocator | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }
  const record = entry as Record<string, unknown>
  return {
    ordinal: state.nextOrdinal,
    jsonlLine,
    byteStart: chunk.byteStart,
    byteLength: chunkByteLength(chunk),
    entryType: typeof entry.type === 'string' ? entry.type : 'unknown',
    messageId: typeof entry.uuid === 'string'
      ? entry.uuid
      : typeof entry.messageId === 'string'
        ? entry.messageId
        : null,
    role: typeof entry.message?.role === 'string' ? entry.message.role : null,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    parentToolUseId: typeof record.parent_tool_use_id === 'string'
      ? record.parent_tool_use_id
      : null,
  }
}

export function reduceTranscriptWithLocators(
  chunks: Iterable<TranscriptChunk>,
  seed?: TranscriptProjection,
  options: TranscriptReductionOptions = {},
): { projection: TranscriptProjection; locators: TranscriptEntryLocator[] } {
  const chunkList = Array.from(chunks)
  const firstChunk = chunkList[0]
  const seedState = seed ? projectionStates.get(seed) : undefined
  const isFullReduction = !firstChunk || firstChunk.byteStart === 0

  if (firstChunk && firstChunk.byteStart !== 0 && !seedState) {
    throw new TranscriptRebuildRequiredError()
  }

  if (firstChunk) {
    let expectedByteStart = isFullReduction ? 0 : seed!.indexedBytes
    let sawIncompleteTail = false
    for (const chunk of chunkList) {
      if (sawIncompleteTail || chunk.byteStart !== expectedByteStart) {
        throw new TranscriptRebuildRequiredError()
      }
      expectedByteStart += chunkByteLength(chunk)
      sawIncompleteTail = !chunk.completeLine
    }
  }

  if (!firstChunk && seed) {
    const projection = cloneProjection(seed)
    if (seedState) projectionStates.set(projection, cloneState(seedState))
    return { projection, locators: [] }
  }

  const state = isFullReduction
    ? createInitialState(seed, options)
    : cloneState(seedState!)
  if (
    !isFullReduction &&
    options.isSubagent !== undefined &&
    state.activityIsSubagent !== options.isSubagent
  ) {
    throw new TranscriptRebuildRequiredError()
  }
  let indexedBytes = isFullReduction ? 0 : seed?.indexedBytes ?? 0
  let pendingTailBytes = 0
  let malformedLineCount = isFullReduction ? 0 : seed?.malformedLineCount ?? 0
  const locators: TranscriptEntryLocator[] = []

  for (const chunk of chunkList) {
    const chunkEnd = chunk.byteStart + chunkByteLength(chunk)
    if (!chunk.completeLine) {
      pendingTailBytes = chunkEnd - indexedBytes
      continue
    }

    indexedBytes = chunkEnd
    pendingTailBytes = 0
    const jsonlLine = state.nextJsonlLine
    state.nextJsonlLine += 1
    const trimmed = chunk.text.trim()
    if (!trimmed) continue

    let entry: ReducerEntry
    try {
      entry = JSON.parse(trimmed) as ReducerEntry
    } catch {
      malformedLineCount += 1
      continue
    }
    applyEntry(state, entry)
    const locator = locatorFromEntry(entry, chunk, state, jsonlLine)
    if (locator) {
      locators.push(locator)
      state.nextOrdinal += 1
    }
  }

  const projection: TranscriptProjection = {
    summary: summaryFromState(state),
    indexedBytes,
    pendingTailBytes,
    malformedLineCount,
    activity: {
      isSubagent: state.activityIsSubagent,
      firstTimestamp: state.activityFirstTimestampValid && state.activityLastTimestampValid
        ? state.activityFirstTimestamp
        : null,
      lastTimestamp: state.activityFirstTimestampValid && state.activityLastTimestampValid
        ? state.activityLastTimestamp
        : null,
      activeDurationMs: state.activityFirstTimestampValid && state.activityLastTimestampValid
        ? state.activityActiveDurationMs
        : 0,
      messageCount: state.activityFirstTimestampValid && state.activityLastTimestampValid
        ? state.activityMessageCount
        : 0,
      startHour: state.activityFirstTimestampValid && state.activityLastTimestampValid
        ? state.activityStartHour
        : null,
      speculationTimeSavedMs: state.activitySpeculationTimeSavedMs,
      shotCount: state.activityShotCount,
      daily: state.activityFirstTimestampValid && state.activityLastTimestampValid
        ? [...state.activityDaily.values()].sort((left, right) =>
            left.date.localeCompare(right.date))
        : [],
      models: state.activityFirstTimestampValid && state.activityLastTimestampValid
        ? [...state.activityModels.values()].sort((left, right) =>
            left.date.localeCompare(right.date) || left.model.localeCompare(right.model))
        : [],
      tools: state.activityFirstTimestampValid && state.activityLastTimestampValid
        ? [...state.activityTools.values()].sort((left, right) =>
            left.date.localeCompare(right.date) || left.name.localeCompare(right.name))
        : [],
      skills: state.activityFirstTimestampValid && state.activityLastTimestampValid
        ? [...state.activitySkills.values()].sort((left, right) =>
            left.date.localeCompare(right.date) || left.name.localeCompare(right.name))
        : [],
    },
  }
  projectionStates.set(projection, cloneState(state))
  return { projection, locators }
}
