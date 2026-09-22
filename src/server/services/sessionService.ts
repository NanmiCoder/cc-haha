import { splitSessionReferenceContext } from './sessionReferenceContext.js'
import { parseSessionCollaborationEnvelope } from '../../utils/sessionCollaborationEnvelope.js'
import { readHistoryContexts } from './sessionHistoryContext.js'
import { recoverBoundedSessionHistory, type SessionHistoryRecovery } from './sessionHistoryRecovery.js'
/**
 * Session Service — 会话文件的读写操作封装
 *
 * 读写 CLI 持久化在 ~/.claude/projects/{sanitized_path}/{sessionId}.jsonl 的会话数据，
 * 确保 Desktop App 与 CLI 的数据完全互通。
 */

import { HISTORY_SEMANTIC_RECORD_BYTES, HISTORY_PAGE_BYTES, displayPreview, readBoundedHistoryPage, streamBoundedHistory, withHistoryReadBudget, type HistoryPageInfo } from './boundedSessionHistory.js'
import { constants, createReadStream, createWriteStream, type Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createInterface } from 'node:readline'
import { ApiError } from '../middleware/errorHandler.js'
import { sanitizePath as sanitizePortablePath } from '../../utils/sessionStoragePortable.js'
import { migrateFileHistorySnapshot, type FileHistorySnapshot } from '../../utils/fileHistory.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { calculateUSDCost, MODEL_COSTS } from '../../utils/modelCost.js'
import {
  MODEL_CONTEXT_WINDOW_DEFAULT,
  getContextWindowForModel,
  getModelMaxOutputTokens,
  is1mContextDisabled,
} from '../../utils/context.js'
import {
  MODEL_CONTEXT_WINDOWS_ENV_KEY,
  getModelContextWindowFromEnvValue,
} from '../../utils/model/modelContextWindows.js'
import {
  calculateContextBudget,
  getProviderUsageTrust,
  hasMediaInput,
} from '../../utils/contextBudget.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import {
  resolveSessionWorkspaceLaunch,
  type CreateSessionRepositoryOptions,
  type PreparedSessionWorkspace,
} from './repositoryLaunchService.js'
import { registerFilesystemAccessRoot } from './filesystemAccessRoots.js'
import { normalizeDriveRootPathForPlatform } from './windowsDrivePath.js'
import { cleanSessionTitleSource } from '../../utils/sessionTitleText.js'
import {
  roughTokenCountEstimationForMessage,
} from '../../services/tokenEstimation.js'
import { ProviderService } from './providerService.js'
import { shouldHideCommandMetadataContent } from '../../utils/commandMetadata.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import {
  extractGoalCreationTitle,
  extractTranscriptUserTitle,
} from './localIndex/transcriptReducer.js'
import type {
  PersistedWorktreeSession,
  SessionListSummary,
} from './localIndex/types.js'
import { localIndexCoordinator } from './localIndex/coordinator.js'
import { readSessionEntriesByLocator } from './localIndex/sessionEntries.js'
import type {
  IndexedSessionRow,
  IndexedSessionSearchCandidate,
  LocalIndexGateway,
  SessionFileMatch,
} from './localIndex/sessionIndex.js'
import type { LocalIndexStatus } from './localIndex/types.js'
import { diagnosticsService } from './diagnosticsService.js'
import {
  isBillableUsageRecord,
  isForkInheritedUsageRecord,
  usageRecordKey,
} from '../../utils/usageAccounting.js'
import {
  ProjectSessionHistory,
  type ProjectHistoryOptions,
  type ProjectHistoryPage,
  type ProjectHistoryRow,
  type ProjectSessionPreviews,
} from './projectSessionHistory.js'

// ============================================================================
// Types
// ============================================================================

export type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  projectRoot: string | null
  workDir: string | null
  workDirExists: boolean
  workspaceState: SessionWorkspaceState
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
}

export type SubagentTranscriptFragment = {
  historyComplete?: boolean
  agentId: string
  messages: MessageEntry[]
  taskNotifications: SessionTaskNotification[]
  modifiedAt: number
}

export type SubagentTranscript = {
  historyComplete?: boolean
  messages: MessageEntry[]
  taskNotifications: SessionTaskNotification[]
}

export type SessionWorkspaceState = 'available' | 'worktree_removed' | 'missing'

export type SessionListShadowComparison = {
  matched: boolean
  fileTotal: number
  indexedTotal: number
  fileCount: number
  indexedCount: number
  differenceCount: number
  fieldHashes: Array<{
    field: string
    fileHash: string
    indexedHash: string
  }>
}

export type SessionServiceLocalIndexOptions = {
  now?: () => number
  indexFailureCooldownMs?: number
  shadowComparisonMinIntervalMs?: number
  recordShadowComparison?: (comparison: SessionListShadowComparison) => void
  targetedEntryReader?: typeof readSessionEntriesByLocator
  sessionListCacheMaxEntries?: number
  sessionListSummaryCacheMaxEntries?: number
}

export type SessionEntriesAtLinesResult = {
  entries: Array<{ entry: Record<string, unknown>; lineNumber: number }>
  bytesRead: number
  rangesRead: number
}

export type IndexedSessionSearchMetadata = {
  title: string
  modifiedAt: string
  workDir: string | null
  projectPath: string
  sourceSnapshot?: {
    dev: number
    ino: number
    size: number
    mtimeMs: number
    ctimeMs: number
  }
}

export type DeleteSessionFailure = {
  sessionId: string
  message: string
  code?: string
}

export type DeleteSessionsResult = {
  successes: string[]
  failures: DeleteSessionFailure[]
}

export type SessionDetail = SessionListItem & {
  messages: MessageEntry[]
}

export type SessionLaunchInfo = {
  filePath: string
  projectDir: string
  workDir: string
  repository?: PreparedSessionWorkspace['repository']
  worktreeSession?: PersistedWorktreeSession | null
  transcriptMessageCount: number
  customTitle: string | null
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
}

type ProviderContextWindowHint = Pick<SessionLaunchInfo, 'runtimeProviderId' | 'runtimeModelId'>

export type SessionInspectionTranscriptSnapshot = {
  launchInfo: SessionLaunchInfo
  metadata: TranscriptMetadataSnapshot
  usage: TranscriptUsageSnapshot | null
  contextEstimate: TranscriptContextEstimate | null
}

export type TrimSessionResult = {
  removedCount: number
  removedMessageIds: string[]
}

export type MessageUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type MessageEntry = {
  sessionReferences?: { sessionId: string }[]
  /** Present when this user-position message was delivered from another session. */
  collaboration?: { sourceSessionId: string; messageId: string }
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  bodyTruncated?: boolean
  toolUseResult?: unknown
  timestamp: string
  model?: string
  usage?: MessageUsage
  /**
   * Identity of the API response `usage` belongs to, when it has one.
   *
   * A single assistant reply is persisted as one line per content block, each repeating the
   * whole `usage` object, so any consumer that totals usage must count a given key once.
   * Computed here (rather than by each consumer) so the rule lives in one place; absent when
   * the line carries no message id, which by the same convention means "always count it".
   */
  usageKey?: string
  parentUuid?: string
  parentToolUseId?: string
  isSidechain?: boolean
  cwd?: string
}

export type SessionMessagesWithEvidence = {
  messages: MessageEntry[]
  transcriptEvidenceComplete: boolean
}

/**
 * Callers that render the session timeline want the root transcript only: the
 * linked subagent tool stream is fetched per Agent card from
 * `/subagents/by-tool`, and merging it here made one real session 542 MB —
 * past the 536,870,888-character string limit, where Chromium silently hands
 * back an empty body and the app shows `Unexpected end of JSON input`.
 *
 * Server-side consumers (rewind checkpoints, team task anchors, workspace
 * change attribution) still need the merged view, which is why the default
 * stays `true`.
 */
export type SessionMessagesOptions = {
  includeSubagents?: boolean
}

type SubagentMessagesResult = {
  messages: MessageEntry[]
  subagentEvidenceComplete: boolean
}

export type SessionTaskNotification = {
  taskId: string
  toolUseId: string
  /** Transcript owner for nested lifecycle events. Undefined is root/legacy. */
  ownerAgentId?: string
  status: 'completed' | 'failed' | 'stopped'
  workflowRunId?: string
  summary?: string
  result?: string
  outputFile?: string
  timestamp?: string
}

/** Canonical terminal identity within a session. Child agents may reuse the
 * same raw leaf tool id, so toolUseId alone is not a stable dedupe key. */
export function sessionTaskNotificationIdentity(
  notification: Pick<SessionTaskNotification, 'ownerAgentId' | 'toolUseId'>,
): string {
  return JSON.stringify([notification.ownerAgentId ?? null, notification.toolUseId])
}

export type TranscriptUsageSnapshot = {
  source: 'transcript'
  totalCostUSD: number
  costDisplay: string
  hasUnknownModelCost: boolean
  totalAPIDuration: number
  totalDecodeDuration: number
  totalTtftDuration: number
  totalDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadInputTokens: number
  totalCacheCreationInputTokens: number
  totalWebSearchRequests: number
  models: Array<{
    model: string
    displayName: string
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
    costDisplay: string
    contextWindow: number
    maxOutputTokens: number
  }>
}

export type TranscriptMetadataSnapshot = {
  model?: string
  cwd?: string
  version?: string
}

export type TranscriptContextEstimate = {
  categories: Array<{
    name: string
    tokens: number
    color: string
    isDeferred?: boolean
  }>
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  gridRows: Array<Array<{
    color: string
    isFilled: boolean
    categoryName: string
    tokens: number
    percentage: number
    squareFullness: number
  }>>
  model: string
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  agents: Array<{ agentType: string; source: string; tokens: number }>
  apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
}

/** Raw entry parsed from a single JSONL line */
type RawEntry = {
  type?: string
  subtype?: string
  content?: unknown
  uuid?: string
  messageId?: string
  parentUuid?: string | null
  parent_tool_use_id?: string | null
  isSidechain?: boolean
  isMeta?: boolean
  forkedFrom?: unknown
  cwd?: string
  message?: {
    role?: string
    content?: unknown
    model?: string
    id?: string
    type?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      server_tool_use?: {
        web_search_requests?: number
      }
      speed?: string
    }
  }
  timestamp?: string
  version?: string
  snapshot?: {
    messageId?: string
    trackedFileBackups?: Record<string, unknown>
    completedFileBackups?: Record<string, unknown>
    timestamp?: string
  }
  customTitle?: string
  permissionMode?: string
  worktreeSession?: PersistedWorktreeSession | null
  title?: string
  [key: string]: unknown
}

type RawMessageUsage = NonNullable<RawEntry['message']>['usage']

type TranscriptContextAccumulator = {
  latestModel: string | null
  latestUsage: {
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  } | null
  estimatedTokensFromMessages: number
  estimatedTokensAfterUsage: number
  transcriptHasMediaInput: boolean
}

/**
 * Whether this line's `usage` is the first sighting of its reply.
 *
 * Claude Code writes one JSONL line per content block of an assistant message and repeats the
 * complete `usage` object on every one — a reply with thinking, text and 12 tool_use blocks is
 * 14 lines carrying the same numbers. Summing raw lines overstated real transcripts by 2.2x,
 * which is why `stats.ts` and the activity index both deduplicate; the inspector paths had
 * inherited only the fork check and so reported inflated totals to the context panel.
 *
 * Rules (and the key shape) come from `usageAccounting.ts` so every reader of a transcript
 * agrees about what one session cost.
 */
function claimUsageRecord(entry: RawEntry, countedKeys: Set<string>): boolean {
  const record = entry as unknown as Record<string, unknown>
  const identity = {
    version: record.version,
    sessionId: record.sessionId,
    requestId: record.requestId,
    messageId: entry.message?.id,
    forkedFrom: record.forkedFrom,
  }
  if (!isBillableUsageRecord(identity)) return false
  const key = usageRecordKey(identity)
  if (key === null) return true
  if (countedKeys.has(key)) return false
  if (countedKeys.size >= 50_000 || key.length > 4096) throw new ApiError(413, 'Usage inspection exceeds its record budget', 'HISTORY_INSPECTION_LIMIT')
  countedKeys.add(key)
  return true
}

function createTranscriptContextAccumulator(): TranscriptContextAccumulator {
  return {
    latestModel: null,
    latestUsage: null,
    estimatedTokensFromMessages: 0,
    estimatedTokensAfterUsage: 0,
    transcriptHasMediaInput: false,
  }
}

function accumulateTranscriptContext(
  state: TranscriptContextAccumulator,
  entry: RawEntry,
): void {
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    state.latestUsage = null
    state.estimatedTokensFromMessages = 0
    state.estimatedTokensAfterUsage = 0
    state.transcriptHasMediaInput = false
  }

  if (typeof entry.message?.model === 'string') {
    state.latestModel = entry.message.model
  }

  if (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment'
  ) {
    const tokens = roughTokenCountEstimationForMessage(entry)
    state.estimatedTokensFromMessages += tokens
    state.estimatedTokensAfterUsage += tokens
    if (!state.transcriptHasMediaInput && hasMediaInput([entry])) {
      state.transcriptHasMediaInput = true
    }
  }

  const usage = entry.message?.usage
  const model = entry.message?.model
  if (!usage || typeof model !== 'string') return

  const inputTokens =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
  const cacheReadInputTokens =
    typeof usage.cache_read_input_tokens === 'number'
      ? usage.cache_read_input_tokens
      : 0
  const cacheCreationInputTokens =
    typeof usage.cache_creation_input_tokens === 'number'
      ? usage.cache_creation_input_tokens
      : 0

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadInputTokens === 0 &&
    cacheCreationInputTokens === 0
  ) {
    return
  }

  state.latestUsage = {
    model,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  }
  state.estimatedTokensAfterUsage = 0
}

function resolveTranscriptContextUsage(
  state: TranscriptContextAccumulator,
): NonNullable<TranscriptContextAccumulator['latestUsage']> | null {
  if (state.latestUsage) return state.latestUsage
  if (!state.latestModel) return null
  return {
    model: state.latestModel,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
}

function normalizeMessageUsage(usage: RawMessageUsage): MessageUsage | undefined {
  if (!usage) return undefined

  const normalized: MessageUsage = {}
  if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
    normalized.input_tokens = usage.input_tokens
  }
  if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
    normalized.output_tokens = usage.output_tokens
  }
  if (
    typeof usage.cache_read_input_tokens === 'number' &&
    Number.isFinite(usage.cache_read_input_tokens)
  ) {
    normalized.cache_read_input_tokens = usage.cache_read_input_tokens
  }
  if (
    typeof usage.cache_creation_input_tokens === 'number' &&
    Number.isFinite(usage.cache_creation_input_tokens)
  ) {
    normalized.cache_creation_input_tokens = usage.cache_creation_input_tokens
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

type SessionListSummaryCacheEntry = {
  mtimeMs: number
  size: number
  summary: SessionListSummary
}

const DEFAULT_SESSION_LIST_CACHE_MAX_ENTRIES = 16
const DEFAULT_SESSION_LIST_SUMMARY_CACHE_MAX_ENTRIES = 20_000

const VALID_SESSION_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
])
const VALID_SESSION_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

type ContentBlock = Record<string, unknown>

const USER_INTERRUPTION_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
])

const NO_RESPONSE_REQUESTED_TEXT = 'No response requested.'
const TASK_NOTIFICATION_RE = /^<task-notification>\s*[\s\S]*<\/task-notification>$/i
const TASK_NOTIFICATION_BLOCK_RE = /<task-notification>\s*[\s\S]*?<\/task-notification>/i
const PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE = 'cc-haha-task-notification'
const PROVIDER_MODEL_ALIAS_SEPARATORS = ['-', '_', ':', '/', '.', ' ']

function normalizeProviderModelAlias(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/i, '')
    .replace(/:1m$/i, '')
    .trim()
}

function providerModelLooksRelated(
  transcriptModel: string,
  configuredModel: string,
): boolean {
  const transcript = normalizeProviderModelAlias(transcriptModel)
  const configured = normalizeProviderModelAlias(configuredModel)
  if (!transcript || !configured) return false
  if (transcript === configured) return true

  const shorter = Math.min(transcript.length, configured.length)
  if (shorter < 6) return false

  return PROVIDER_MODEL_ALIAS_SEPARATORS.some((separator) => (
    transcript.startsWith(`${configured}${separator}`) ||
    configured.startsWith(`${transcript}${separator}`)
  ))
}

// ============================================================================
// Service
// ============================================================================

type SharedSessionMutationState = {
  epoch: number
  bypass: {
    completionMarker: string | null
    requiresAdditionalCompletion: boolean
  } | null
}

const sharedSessionMutationStates = new WeakMap<LocalIndexGateway, SharedSessionMutationState>()

function getSharedSessionMutationState(
  gateway: LocalIndexGateway,
): SharedSessionMutationState {
  const existing = sharedSessionMutationStates.get(gateway)
  if (existing) return existing
  const created: SharedSessionMutationState = { epoch: 0, bypass: null }
  sharedSessionMutationStates.set(gateway, created)
  return created
}

// Read-time evidence only: spreads preserve it, JSON serialization does not.
// A malformed before map must not become indistinguishable from a valid {}.
const malformedFileHistoryBefore = Symbol('malformed-file-history-before')

export function hasMalformedFileHistoryBefore(snapshot: FileHistorySnapshot): boolean {
  return (snapshot as FileHistorySnapshot & { [malformedFileHistoryBefore]?: true })[malformedFileHistoryBefore] === true
}

export class SessionService {
  private readonly uiFileHistoryReads = new Map<string, Promise<RawEntry[]>>()
  private readonly inspectionSnapshots = new Map<string, Promise<SessionInspectionTranscriptSnapshot | null>>()

  private providerService = new ProviderService()
  // Keep launch state available when retention disables or removes transcripts.
  // Scope keys by config directory so test/embedded server instances cannot mix state.
  private readonly memoryLaunchInfo = new Map<string, SessionLaunchInfo>()
  // Creation or a valid runtime metadata update establishes a session lifetime
  // independently of its transcript. Cleanup can remove that file before the
  // next runtime update supplies memoryLaunchInfo.
  private readonly knownSessionKeys = new Set<string>()
  private readonly privateTitles = new Map<string, Set<string>>()

  shouldPersistSession(): boolean {
    return getSettings_DEPRECATED()?.cleanupPeriodDays !== 0
  }

  private memorySessionKey(sessionId: string): string {
    return `${this.getConfigDir()}:${sessionId}`
  }

  private rememberPrivateTitle(sessionId: string, title: string): void {
    const key = this.memorySessionKey(sessionId)
    const titles = this.privateTitles.get(key) ?? new Set<string>()
    titles.add(title)
    this.privateTitles.set(key, titles)
  }

  private canPersistTitle(sessionId: string, title: string): boolean {
    return this.shouldPersistSession() &&
      !this.privateTitles.get(this.memorySessionKey(sessionId))?.has(title)
  }

  private readonly subagentLookupCache = new Map<string, { version: string; transcript: SubagentTranscript }>()
  private readonly historyRecoveryCache = new Map<string, SessionHistoryRecovery>()
  private readonly metadataProjectionCache = new Map<string, { signature: string; summary: SessionListSummary; launchInfo: SessionLaunchInfo; customTitle: string | null; complete: boolean }>()
  private readonly metadataProjectionRequests = new Map<string, Promise<{ summary: SessionListSummary; launchInfo: SessionLaunchInfo; customTitle: string | null; complete: boolean }>>()

  private readonly sessionHistoryRequests = new Map<string, Promise<{
    messages: MessageEntry[]
    taskNotifications: SessionTaskNotification[]
  }>>()

  private readonly pendingTaskNotificationWrites = new Map<
    string,
    Set<{
      controller: AbortController
      promise: Promise<void>
      notification: SessionTaskNotification
      persisted: boolean
    }>
  >()
  private readonly taskNotificationMutationEpochs = new Map<string, number>()
  private readonly clearingTaskNotificationSessions = new Set<string>()

  private readonly localIndexGateway: LocalIndexGateway
  private readonly now: () => number
  private readonly indexFailureCooldownMs: number
  private readonly shadowComparisonMinIntervalMs: number
  private readonly recordShadowComparison: (comparison: SessionListShadowComparison) => void
  private readonly targetedEntryReader: typeof readSessionEntriesByLocator
  private indexFailureCooldownUntil = 0
  private observedSharedMutationEpoch: number
  private lastShadowComparisonSignature: string | null = null
  private lastShadowComparisonRecordedAt = Number.NEGATIVE_INFINITY

  private readonly sessionListCacheTtlMs = 5_000
  private readonly sessionListCacheMaxEntries: number
  private readonly sessionListSummaryCacheMaxEntries: number
  private readonly sessionListCache = new Map<string, {
    expiresAt: number
    result: { sessions: SessionListItem[]; total: number }
  }>()
  private readonly sessionListRequests = new Map<
    string,
    Promise<{ sessions: SessionListItem[]; total: number }>
  >()
  private sessionListCacheGeneration = 0
  private readonly sessionListSummaryCache = new Map<string, SessionListSummaryCacheEntry>()
  private readonly sessionListSummaryRequests = new Map<string, Promise<SessionListSummary>>()
  private activeSessionListCacheScope: string | null = null
  private readonly projectHistory: ProjectSessionHistory

  constructor(
    localIndexGateway: LocalIndexGateway = localIndexCoordinator,
    options: SessionServiceLocalIndexOptions = {},
  ) {
    this.localIndexGateway = localIndexGateway
    this.observedSharedMutationEpoch = getSharedSessionMutationState(localIndexGateway).epoch
    this.now = options.now ?? Date.now
    this.indexFailureCooldownMs = options.indexFailureCooldownMs ?? 5_000
    this.shadowComparisonMinIntervalMs = options.shadowComparisonMinIntervalMs ?? 30_000
    this.sessionListCacheMaxEntries = this.normalizeCacheCapacity(
      options.sessionListCacheMaxEntries,
      DEFAULT_SESSION_LIST_CACHE_MAX_ENTRIES,
    )
    this.sessionListSummaryCacheMaxEntries = this.normalizeCacheCapacity(
      options.sessionListSummaryCacheMaxEntries,
      DEFAULT_SESSION_LIST_SUMMARY_CACHE_MAX_ENTRIES,
    )
    this.recordShadowComparison = options.recordShadowComparison ?? ((comparison) => {
      void diagnosticsService.recordEvent({
        type: 'local_index_session_shadow_comparison',
        severity: comparison.matched ? 'info' : 'warn',
        summary: comparison.matched
          ? 'Local session index shadow comparison matched'
          : 'Local session index shadow comparison differed',
        details: comparison,
      })
    })
    this.targetedEntryReader = options.targetedEntryReader ?? readSessionEntriesByLocator
    this.projectHistory = new ProjectSessionHistory({
      now: this.now,
      scope: () => this.getConfigDir(),
      revision: () => this.projectHistoryRevision(),
      mutation: () => `${this.getConfigDir()}:${getSharedSessionMutationState(this.localIndexGateway).epoch}`,
      load: () => this.loadProjectHistoryRows(),
      hydrate: async (row) => {
        try {
          await this.validateIndexedTranscriptPath(
            row.transcriptPath, row.projectPath, row.id, await fs.realpath(this.getProjectsDir()),
          )
          return await this.hydrateIndexedSession(row)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          this.markIndexReadFailure()
          throw new ApiError(409, 'Project history changed; retry from the first page', 'PROJECT_HISTORY_CHANGED')
        }
      },
    })
  }

  private normalizeCacheCapacity(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : fallback
  }

  private sessionListCacheKey(options: {
    project?: string
    limit?: number
    offset?: number
  } | undefined, scope = this.getConfigDir()): string {
    return JSON.stringify({
      scope,
      project: options?.project ?? null,
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    })
  }

  private cloneSessionListResult(result: { sessions: SessionListItem[]; total: number }): { sessions: SessionListItem[]; total: number } {
    return {
      total: result.total,
      sessions: result.sessions.map((session) => ({ ...session })),
    }
  }

  private invalidateSessionListCache(): void {
    this.sessionListCache.clear()
    this.sessionListCacheGeneration += 1
    const sharedState = getSharedSessionMutationState(this.localIndexGateway)
    sharedState.epoch += 1
    sharedState.bypass = this.readIndexMutationBypass()
    this.observedSharedMutationEpoch = sharedState.epoch
  }

  private syncIndexedSessionTitle(sessionId: string, title: string): void {
    // Title entries are tiny, authoritative mutations. Patch an existing index
    // row immediately so a cold restart cannot briefly serve the older title
    // while the transcript watcher is still queued. The watcher still performs
    // the full source projection (fingerprint, locators, and metadata) later.
    this.localIndexGateway.updateSessionTitle?.(sessionId, title)
  }

  private prepareSessionListCaches(scope: string): void {
    if (this.activeSessionListCacheScope !== scope) {
      this.sessionListCache.clear()
      this.sessionListSummaryCache.clear()
      this.sessionListCacheGeneration += 1
      this.activeSessionListCacheScope = scope
    }

    const now = this.now()
    for (const [key, entry] of this.sessionListCache) {
      if (entry.expiresAt <= now) this.sessionListCache.delete(key)
    }
  }

  private touchSessionListCacheEntry(
    key: string,
    entry: { expiresAt: number; result: { sessions: SessionListItem[]; total: number } },
  ): void {
    this.sessionListCache.delete(key)
    this.sessionListCache.set(key, entry)
  }

  private enforceSessionListCacheCapacity(): void {
    while (this.sessionListCache.size > this.sessionListCacheMaxEntries) {
      const oldestKey = this.sessionListCache.keys().next().value
      if (oldestKey === undefined) break
      this.sessionListCache.delete(oldestKey)
    }
  }

  private enforceSessionListSummaryCacheCapacity(): void {
    while (this.sessionListSummaryCache.size > this.sessionListSummaryCacheMaxEntries) {
      const oldestKey = this.sessionListSummaryCache.keys().next().value
      if (oldestKey === undefined) break
      this.sessionListSummaryCache.delete(oldestKey)
    }
  }

  private syncSharedMutationEpoch(): void {
    const sharedState = getSharedSessionMutationState(this.localIndexGateway)
    if (sharedState.epoch === this.observedSharedMutationEpoch) return
    this.sessionListCache.clear()
    this.sessionListCacheGeneration += 1
    this.observedSharedMutationEpoch = sharedState.epoch
  }

  private readIndexMutationBypass(): NonNullable<SharedSessionMutationState['bypass']> {
    try {
      const status = this.localIndexGateway.getPublicStatus()
      return {
        completionMarker: status.lastUpdatedAt,
        requiresAdditionalCompletion: status.state === 'building',
      }
    } catch {
      return {
        completionMarker: 'unavailable',
        requiresAdditionalCompletion: true,
      }
    }
  }

  private markIndexReadFailure(): void {
    this.indexFailureCooldownUntil = Math.max(
      this.indexFailureCooldownUntil,
      this.now() + this.indexFailureCooldownMs,
    )
  }

  private getUsableIndexMode(): 'shadow' | 'on' | null {
    let mode: 'off' | 'shadow' | 'on'
    try {
      mode = this.localIndexGateway.getMode()
    } catch {
      this.markIndexReadFailure()
      return null
    }
    if (mode === 'off' || this.now() < this.indexFailureCooldownUntil) return null

    let status: LocalIndexStatus
    try {
      status = this.localIndexGateway.getPublicStatus()
    } catch {
      this.markIndexReadFailure()
      return null
    }

    const sharedState = getSharedSessionMutationState(this.localIndexGateway)
    if (sharedState.bypass !== null) {
      if (
        status.state !== 'ready' ||
        status.lastUpdatedAt === sharedState.bypass.completionMarker
      ) {
        return null
      }
      if (sharedState.bypass.requiresAdditionalCompletion) {
        sharedState.bypass = {
          completionMarker: status.lastUpdatedAt,
          requiresAdditionalCompletion: false,
        }
        return null
      }
      sharedState.bypass = null
    }

    if (status.state === 'off' || status.state === 'degraded') return null
    try {
      if (status.state !== 'building' && !this.localIndexGateway.isSessionScopeReady()) {
        return null
      }
    } catch {
      this.markIndexReadFailure()
      return null
    }
    return mode
  }

  private indexStatusRemainsUsable(): boolean {
    try {
      const status = this.localIndexGateway.getPublicStatus()
      return status.state !== 'off' && status.state !== 'degraded'
    } catch {
      return false
    }
  }

  private cloneSessionListSummary(summary: SessionListSummary): SessionListSummary {
    return {
      ...summary,
      repository: summary.repository ? { ...summary.repository } : undefined,
      worktreeSession: summary.worktreeSession
        ? { ...summary.worktreeSession }
        : summary.worktreeSession,
    }
  }

  private latestTimestamp(current: string | null, candidate: unknown): string | null {
    if (typeof candidate !== 'string') return current
    const candidateTime = Date.parse(candidate)
    if (!Number.isFinite(candidateTime)) return current
    if (!current) return candidate
    const currentTime = Date.parse(current)
    return !Number.isFinite(currentTime) || candidateTime > currentTime
      ? candidate
      : current
  }

  private metadataMatchesLaunchInfo(
    launchInfo: SessionLaunchInfo | null,
    metadata: {
      workDir: string
      repository?: PreparedSessionWorkspace['repository']
      permissionMode?: string
      runtimeProviderId?: string | null
      runtimeModelId?: string
      effortLevel?: string
    },
  ): boolean {
    if (!launchInfo) return false
    if (normalizeDriveRootPathForPlatform(launchInfo.workDir) !== metadata.workDir) {
      return false
    }
    if (
      JSON.stringify(launchInfo.repository ?? null) !==
      JSON.stringify(metadata.repository ?? null)
    ) {
      return false
    }
    if (
      metadata.permissionMode &&
      VALID_SESSION_PERMISSION_MODES.has(metadata.permissionMode) &&
      launchInfo.permissionMode !== metadata.permissionMode
    ) {
      return false
    }
    if (
      metadata.runtimeProviderId !== undefined &&
      launchInfo.runtimeProviderId !== metadata.runtimeProviderId
    ) {
      return false
    }
    if (metadata.runtimeModelId && launchInfo.runtimeModelId !== metadata.runtimeModelId) {
      return false
    }
    if (
      metadata.effortLevel &&
      VALID_SESSION_EFFORT_LEVELS.has(metadata.effortLevel) &&
      launchInfo.effortLevel !== metadata.effortLevel
    ) {
      return false
    }
    return true
  }

  private async getCachedSessionListSummary(
    filePath: string,
    projectDir: string,
    stat: Stats,
    scope: string,
  ): Promise<SessionListSummary> {
    const cached = this.sessionListSummaryCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.sessionListSummaryCache.delete(filePath)
      this.sessionListSummaryCache.set(filePath, cached)
      return this.cloneSessionListSummary(cached.summary)
    }

    const requestKey = `${filePath}:${stat.mtimeMs}:${stat.size}`
    const inFlight = this.sessionListSummaryRequests.get(requestKey)
    if (inFlight) {
      return this.cloneSessionListSummary(await inFlight)
    }

    const request = this.scanSessionListSummary(filePath, projectDir, stat)
    this.sessionListSummaryRequests.set(requestKey, request)
    try {
      const summary = await request
      if (this.activeSessionListCacheScope === scope) {
        this.sessionListSummaryCache.set(filePath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          summary: this.cloneSessionListSummary(summary),
        })
        this.enforceSessionListSummaryCacheCapacity()
      }
      return this.cloneSessionListSummary(summary)
    } finally {
      if (this.sessionListSummaryRequests.get(requestKey) === request) {
        this.sessionListSummaryRequests.delete(requestKey)
      }
    }
  }

  // --------------------------------------------------------------------------
  // Config helpers
  // --------------------------------------------------------------------------

  private getConfigDir(): string {
    return path.resolve(getClaudeConfigHomeDir())
  }

  private getProjectsDir(): string {
    return path.join(this.getConfigDir(), 'projects')
  }

  /**
   * Sanitize a path the same way the shared session storage does.
   * This must remain Windows-safe, so reserved characters such as ':' are normalized too.
   */
  private sanitizePath(dirPath: string): string {
    return sanitizePortablePath(dirPath)
  }

  // --------------------------------------------------------------------------
  // JSONL parsing
  // --------------------------------------------------------------------------

  private async readJsonlFileWithDiagnostics(filePath: string): Promise<{
    entries: RawEntry[]
    exists: boolean
    parseComplete: boolean
  }> {
    const entries: RawEntry[] = []
    let parseComplete = true
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          entries.push(JSON.parse(trimmed) as RawEntry)
        } catch {
          parseComplete = false
        }
      }
      return { entries, exists: true, parseComplete }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], exists: false, parseComplete: false }
      }
      throw err
    } finally {
      lines.close()
      stream.destroy()
    }
  }

  private async readJsonlFile(filePath: string): Promise<RawEntry[]> {
    return (await this.readJsonlFileWithDiagnostics(filePath)).entries
  }

  private async readTargetedJsonlEntries(
    found: { filePath: string; projectDir: string },
    entryTypes: string[],
  ): Promise<RawEntry[] | null> {
    if (
      this.getUsableIndexMode() !== 'on' ||
      !this.localIndexGateway.getSessionEntryLocators
    ) {
      return null
    }

    const mutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    try {
      const page = this.localIndexGateway.getSessionEntryLocators(
        found.filePath,
        entryTypes,
      )
      if (!page) {
        this.markIndexReadFailure()
        return null
      }
      const result = await this.targetedEntryReader({
        transcriptPath: found.filePath,
        projectsRoot: this.getProjectsDir(),
        expectedProjectDir: found.projectDir,
        page,
      })
      if (!result) {
        this.markIndexReadFailure()
        return null
      }
      if (
        mutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch ||
        !this.indexStatusRemainsUsable()
      ) {
        return null
      }
      return result.entries as RawEntry[]
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  /**
   * Resolve physical JSONL line numbers through verified byte locators.
   * Returns null whenever the index cannot prove an exact, current mapping so
   * callers can preserve their canonical-file behavior.
   */
  async readSessionEntriesAtLines(
    filePath: string,
    lineNumbers: Set<number>,
    entryTypes: string[],
  ): Promise<SessionEntriesAtLinesResult | null> {
    if (
      this.getUsableIndexMode() !== 'on' ||
      !this.localIndexGateway.getSessionEntryLocators
    ) return null

    const projectDir = path.basename(path.dirname(filePath))
    const mutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    try {
      // Fetch all scalar locators so a ripgrep hit on a non-message entry is
      // distinguishable from an uncovered partial/stale physical line.
      const page = this.localIndexGateway.getSessionEntryLocators(filePath)
      if (!page) return null
      const byLine = new Map(page.entries.map(locator => [locator.jsonlLine, locator]))
      if ([...lineNumbers].some(lineNumber => !byLine.has(lineNumber))) return null

      const allowedTypes = new Set(entryTypes)
      const selected = [...lineNumbers]
        .sort((a, b) => a - b)
        .map(lineNumber => byLine.get(lineNumber)!)
        .filter(locator => allowedTypes.has(locator.entryType))
      const result = await this.targetedEntryReader({
        transcriptPath: filePath,
        projectsRoot: this.getProjectsDir(),
        expectedProjectDir: projectDir,
        page: { source: page.source, entries: selected },
      })
      if (
        !result ||
        mutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch ||
        !this.indexStatusRemainsUsable()
      ) return null

      return {
        entries: result.entries.map((entry, index) => ({
          entry,
          lineNumber: selected[index]!.jsonlLine,
        })),
        bytesRead: result.bytesRead,
        rangesRead: result.rangesRead,
      }
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  private async streamJsonlFile(
    filePath: string,
    onEntry: (entry: RawEntry) => void,
  ): Promise<void> {
    await withHistoryReadBudget(undefined, async () => {
      // Inspection reduces original records, just like metadata/replay. A display
      // preview limit must not reject normal image or large tool-result records.
      const result = await streamBoundedHistory(filePath, entry => onEntry(entry as RawEntry), undefined, {
        maxRecordBytes: HISTORY_SEMANTIC_RECORD_BYTES,
      })
      // Preserve the JSONL reader's tolerance for malformed lines and live partial
      // tails, but never report authoritative totals after dropping oversized data.
      if (result.oversizedRecords > 0) throw new ApiError(413, 'Transcript inspection contains records above the semantic read limit', 'HISTORY_INSPECTION_LIMIT')
    }, 'recovery')
  }

  private async scanSessionListSummary(
    filePath: string,
    projectDir: string,
    _stat: { birthtime: Date; mtime: Date },
  ): Promise<SessionListSummary> {
    return (await this.getMetadataProjection(filePath, projectDir)).summary
  }

  private async getMetadataProjection(filePath: string, projectDir: string): Promise<{
    summary: SessionListSummary
    launchInfo: SessionLaunchInfo
    customTitle: string | null
    complete: boolean
  }> {
    const stat = await fs.stat(filePath, { bigint: true })
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
    const key = `${this.getConfigDir()}\0${filePath}`
    const cached = this.metadataProjectionCache.get(key)
    if (cached?.signature === signature) {
      this.metadataProjectionCache.delete(key)
      this.metadataProjectionCache.set(key, cached)
      return cached
    }
    const requestKey = `${key}\0${signature}`
    const pending = this.metadataProjectionRequests.get(requestKey)
    if (pending) return pending
    const request = withHistoryReadBudget(undefined, async () => {
      const makeState = () => ({
        workDir: undefined as string | undefined, cwd: undefined as string | undefined,
        repository: undefined as PreparedSessionWorkspace['repository'] | undefined,
        worktreeSession: undefined as PersistedWorktreeSession | null | undefined,
        permissionMode: undefined as string | undefined,
        runtimeProviderId: undefined as string | null | undefined,
        runtimeModelId: undefined as string | undefined, effortLevel: undefined as string | undefined,
        customTitle: null as string | null, nonemptyCustomTitle: null as string | null,
        goalTitle: null as string | null, aiTitle: null as string | null, firstUserTitle: null as string | null,
        createdAt: null as string | null, modifiedAt: null as string | null,
        count: 0, launchCount: 0,
      })
      const launch = makeState()
      const summary = makeState()
      const apply = (state: ReturnType<typeof makeState>, entry: RawEntry) => {
        if (!state.createdAt && entry.timestamp) state.createdAt = entry.timestamp
        if ((entry.type === 'user' || entry.type === 'assistant') && entry.message?.role) {
          state.count++
          if (!entry.isMeta) state.modifiedAt = this.latestTimestamp(state.modifiedAt, entry.timestamp)
        }
        state.launchCount += this.countTranscriptMessages([entry])
        if (typeof entry.cwd === 'string' && entry.cwd.trim()) state.cwd = normalizeDriveRootPathForPlatform(entry.cwd)
        const record = entry as Record<string, unknown>
        if (entry.type === 'session-meta') {
          if (typeof record.workDir === 'string') state.workDir = normalizeDriveRootPathForPlatform(record.workDir)
          state.permissionMode = this.resolvePermissionModeFromEntries([entry]) ?? state.permissionMode
          if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') state.runtimeProviderId = record.runtimeProviderId as string | null
          if (typeof record.runtimeModelId === 'string') state.runtimeModelId = record.runtimeModelId
          if (typeof record.effortLevel === 'string' && VALID_SESSION_EFFORT_LEVELS.has(record.effortLevel)) state.effortLevel = record.effortLevel
        }
        state.repository = this.resolveRepositoryFromEntries([entry]) ?? state.repository
        const worktree = this.resolveWorktreeSessionFromEntries([entry])
        if (worktree !== undefined) state.worktreeSession = worktree
        if (entry.type === 'custom-title') {
          if (typeof entry.customTitle === 'string') state.customTitle = entry.customTitle
          if (typeof entry.customTitle === 'string' && entry.customTitle.trim()) state.nonemptyCustomTitle = entry.customTitle
        }
        state.goalTitle ??= extractGoalCreationTitle(entry)
        if (entry.type === 'ai-title' && entry.aiTitle) state.aiTitle = cleanSessionTitleSource(String(entry.aiTitle)) || state.aiTitle
        if (!state.firstUserTitle && entry.type === 'user' && !entry.isMeta && entry.message?.role === 'user') state.firstUserTitle = extractTranscriptUserTitle(entry.message.content)
        // Metadata has a separate fixed bound even when a file contains only
        // a handful of maliciously large scalar values or repository fields.
        if (Buffer.byteLength(JSON.stringify(state)) > 128 * 1024) throw new ApiError(413, 'Session metadata exceeds its resource budget', 'SESSION_METADATA_TOO_LARGE')
      }
      const scan = await streamBoundedHistory(filePath, (entry, completeLine) => {
        apply(launch, entry as RawEntry)
        if (completeLine) apply(summary, entry as RawEntry)
      }, undefined, { maxRecordBytes: HISTORY_SEMANTIC_RECORD_BYTES })
      const shared = (state: typeof summary) => ({
        ...(state.permissionMode ? { permissionMode: state.permissionMode } : {}),
        ...(state.runtimeProviderId !== undefined ? { runtimeProviderId: state.runtimeProviderId } : {}),
        ...(state.runtimeModelId ? { runtimeModelId: state.runtimeModelId } : {}),
        ...(state.effortLevel ? { effortLevel: state.effortLevel } : {}),
        ...(state.repository ? { repository: state.repository } : {}),
        ...(state.worktreeSession !== undefined ? { worktreeSession: state.worktreeSession } : {}),
      })
      const result = {
        summary: {
          title: summary.customTitle || summary.goalTitle || summary.aiTitle || summary.firstUserTitle || 'Untitled Session',
          createdAt: summary.createdAt ?? stat.birthtime.toISOString(),
          modifiedAt: summary.modifiedAt ?? stat.mtime.toISOString(),
          messageCount: summary.count,
          workDir: summary.workDir || summary.cwd || this.desanitizePath(projectDir),
          ...shared(summary),
        },
        launchInfo: {
          filePath, projectDir,
          workDir: (launch.workDir !== undefined ? launch.workDir : launch.cwd ?? this.desanitizePath(projectDir)) || process.cwd(),
          customTitle: launch.customTitle,
          transcriptMessageCount: launch.launchCount,
          ...shared(launch),
        },
        customTitle: launch.nonemptyCustomTitle,
        complete: scan.oversizedRecords === 0,
      }
      this.metadataProjectionCache.delete(key)
      this.metadataProjectionCache.set(key, { signature: scan.sourceVersion, ...result })
      while (this.metadataProjectionCache.size > 32) this.metadataProjectionCache.delete(this.metadataProjectionCache.keys().next().value!)
      return result
    }, 'metadata')
    this.metadataProjectionRequests.set(requestKey, request)
    try { return await request } finally { this.metadataProjectionRequests.delete(requestKey) }
  }

  /**
   * Resolve a session's display title + lightweight metadata from its JSONL file.
   *
   * Reuses the same title precedence as the session list (custom-title > goal >
   * ai-title > first user message), so global session search shows real titles
   * instead of the raw UUID file name.
   */
  async getSessionTitleAndMeta(filePath: string): Promise<{
    title: string
    modifiedAt: string
    workDir: string | null
    projectPath: string
  }> {
    const sessionId = path.basename(filePath, '.jsonl')
    const indexedMeta = this.getIndexedSessionMetaById(sessionId)
    if (indexedMeta) {
      return {
        title: indexedMeta.title,
        modifiedAt: indexedMeta.modifiedAt,
        workDir: indexedMeta.workDir,
        projectPath: indexedMeta.projectPath,
      }
    }
    this.syncSharedMutationEpoch()
    const scope = this.getConfigDir()
    this.prepareSessionListCaches(scope)
    const stat = await fs.stat(filePath)
    const projectPath = path.basename(path.dirname(filePath))
    const summary = await this.getCachedSessionListSummary(filePath, projectPath, stat, scope)
    return {
      title: summary.title,
      modifiedAt: summary.modifiedAt,
      workDir: summary.workDir ?? null,
      projectPath,
    }
  }

  getIndexedSessionMetaById(sessionId: string): {
    title: string
    modifiedAt: string
    projectPath: string
    workDir: string | null
  } | null {
    if (this.getUsableIndexMode() !== 'on') return null
    try {
      const row = this.localIndexGateway.getSession?.(sessionId) ?? null
      if (!row || !this.indexStatusRemainsUsable()) return null
      return {
        title: row.title,
        modifiedAt: row.modifiedAt,
        projectPath: row.projectPath,
        workDir: row.workDir,
      }
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  async getIndexedSessionSearchMetadata(
    filePaths: string[],
  ): Promise<Map<string, IndexedSessionSearchMetadata> | null> {
    if (this.getUsableIndexMode() !== 'on') return null
    const wanted = new Set(filePaths.map(filePath => path.resolve(filePath)))
    const projects = new Set(filePaths.map(filePath => path.basename(path.dirname(filePath))))
    const mutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    const result = new Map<string, IndexedSessionSearchMetadata>()
    try {
      for (const project of projects) {
        const page = this.localIndexGateway.listSessions({
          project,
          limit: 2_147_483_647,
          offset: 0,
        })
        for (const session of page.sessions) {
          const transcriptPath = path.resolve(session.transcriptPath)
          if (!wanted.has(transcriptPath)) continue
          result.set(transcriptPath, {
            title: session.title,
            modifiedAt: session.modifiedAt,
            workDir: session.workDir,
            projectPath: session.projectPath,
          })
        }
      }
      if (
        mutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch ||
        !this.indexStatusRemainsUsable()
      ) return null
      return result
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  /**
   * Return a complete, filterable session path set for search phase A.
   * Null means the index cannot currently prove completeness, so callers must
   * preserve canonical filesystem scanning.
   */
  async getIndexedSessionSearchCandidates(filters: {
    project?: string
    modifiedAfter?: string
    modifiedBefore?: string
  }): Promise<Map<string, IndexedSessionSearchMetadata> | null> {
    // A date-only canonical search recursively includes nested subagent JSONL
    // files, which are not rows in the main-session table. Project-filtered
    // search already excludes those paths by parent directory, so only that
    // shape can be narrowed without changing historical results.
    if (
      !filters.project ||
      filters.project === '.' ||
      filters.project === '..' ||
      filters.project.includes('/') ||
      filters.project.includes('\\') ||
      path.basename(filters.project) !== filters.project
    ) return null
    if (this.getUsableIndexMode() !== 'on') return null
    const mutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    try {
      const statusBefore = this.localIndexGateway.getPublicStatus()
      if (
        statusBefore.state !== 'ready' ||
        statusBefore.degradedSources !== 0 ||
        statusBefore.discovered !== statusBefore.indexed
      ) return null

      const modifiedAfterMs = filters.modifiedAfter
        ? Date.parse(filters.modifiedAfter)
        : Number.NEGATIVE_INFINITY
      const modifiedBeforeMs = filters.modifiedBefore
        ? Date.parse(filters.modifiedBefore)
        : Number.POSITIVE_INFINITY
      if (Number.isNaN(modifiedAfterMs) || Number.isNaN(modifiedBeforeMs)) {
        return new Map()
      }

      const findCandidates = this.localIndexGateway.findSearchCandidates
      if (!findCandidates) return null
      const allCandidates = findCandidates.call(this.localIndexGateway, {
        project: filters.project,
      })
      if (!allCandidates) return null
      const candidates = Number.isFinite(modifiedAfterMs) || Number.isFinite(modifiedBeforeMs)
        ? findCandidates.call(this.localIndexGateway, {
            project: filters.project,
            ...(Number.isFinite(modifiedAfterMs) ? { modifiedAfterMs } : {}),
            ...(Number.isFinite(modifiedBeforeMs) ? { modifiedBeforeMs } : {}),
          })
        : allCandidates
      if (!candidates) return null

      const projectsRoot = path.resolve(this.getProjectsDir())
      const projectRoot = path.resolve(projectsRoot, filters.project)
      const projectRelative = path.relative(projectsRoot, projectRoot)
      if (
        projectRelative !== filters.project ||
        projectRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(projectRelative)
      ) return null

      const directoryBefore = await fs.stat(projectRoot)
      if (!directoryBefore.isDirectory()) return null
      const directoryEntries = await fs.readdir(projectRoot, { withFileTypes: true })
      const canonicalPaths = new Set(directoryEntries
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => path.resolve(projectRoot, entry.name)))

      const validateCandidates = (
        values: IndexedSessionSearchCandidate[],
      ): Map<string, IndexedSessionSearchMetadata> | null => {
        const validated = new Map<string, IndexedSessionSearchMetadata>()
        for (const session of values) {
          const transcriptPath = path.resolve(session.transcriptPath)
          const expectedPath = path.resolve(
            projectsRoot,
            session.projectPath,
            `${session.id}.jsonl`,
          )
          if (
            !session.projectPath ||
            path.basename(session.projectPath) !== session.projectPath ||
            transcriptPath !== expectedPath ||
            session.projectPath !== filters.project ||
            !Number.isFinite(Date.parse(session.modifiedAt))
          ) return null
          validated.set(transcriptPath, {
            title: session.title,
            modifiedAt: session.modifiedAt,
            workDir: session.workDir,
            projectPath: session.projectPath,
          })
        }
        return validated
      }

      const allValidated = validateCandidates(allCandidates)
      const result = validateCandidates(candidates)
      if (!allValidated || !result) return null
      if (
        canonicalPaths.size !== allValidated.size ||
        [...canonicalPaths].some(transcriptPath => !allValidated.has(transcriptPath))
      ) return null

      const currentFilteredPaths = new Set<string>()
      for (const [transcriptPath, metadata] of allValidated) {
        const snapshot = await fs.stat(transcriptPath)
        if (!snapshot.isFile()) return null
        const sourceSnapshot = {
          dev: snapshot.dev,
          ino: snapshot.ino,
          size: snapshot.size,
          mtimeMs: snapshot.mtimeMs,
          ctimeMs: snapshot.ctimeMs,
        }
        metadata.sourceSnapshot = sourceSnapshot
        const selectedMetadata = result.get(transcriptPath)
        if (selectedMetadata) selectedMetadata.sourceSnapshot = sourceSnapshot
        if (Number.isFinite(modifiedAfterMs) || Number.isFinite(modifiedBeforeMs)) {
          if (
            snapshot.mtimeMs >= modifiedAfterMs &&
            snapshot.mtimeMs <= modifiedBeforeMs
          ) currentFilteredPaths.add(transcriptPath)
        }
      }
      if (Number.isFinite(modifiedAfterMs) || Number.isFinite(modifiedBeforeMs)) {
        if (
          currentFilteredPaths.size !== result.size ||
          [...currentFilteredPaths].some(transcriptPath => !result.has(transcriptPath))
        ) return null
      }

      const directoryAfter = await fs.stat(projectRoot)
      if (
        directoryBefore.dev !== directoryAfter.dev ||
        directoryBefore.ino !== directoryAfter.ino ||
        directoryBefore.size !== directoryAfter.size ||
        directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
        directoryBefore.ctimeMs !== directoryAfter.ctimeMs
      ) return null

      const statusAfter = this.localIndexGateway.getPublicStatus()
      if (
        mutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch ||
        statusAfter.state !== 'ready' ||
        statusAfter.degradedSources !== 0 ||
        statusAfter.discovered !== statusAfter.indexed ||
        statusAfter.indexed !== statusBefore.indexed ||
        statusAfter.lastUpdatedAt !== statusBefore.lastUpdatedAt
      ) return null
      return result
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  private async appendJsonlEntry(
    filePath: string,
    entry: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.shouldPersistSession()) return
    const line = JSON.stringify(entry) + '\n'
    // A delayed title/notification must not recreate a transcript removed by
    // retention cleanup after lookup. Metadata relocation opts into creation.
    let handle: fs.FileHandle
    try {
      handle = await fs.open(filePath, constants.O_WRONLY | constants.O_APPEND |
        (entry.type === 'session-meta' ? constants.O_CREAT : 0))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      if (!this.shouldPersistSession()) return
      await handle.writeFile(line, { encoding: 'utf-8', signal })
    } finally {
      await handle.close()
    }
  }

  private resolveWorkDirFromEntries(
    entries: RawEntry[],
    fallbackProjectDir?: string,
  ): string | null {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.type === 'session-meta' && typeof (entry as Record<string, unknown>).workDir === 'string') {
        return normalizeDriveRootPathForPlatform((entry as Record<string, unknown>).workDir as string)
      }
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      const cwd = entries[i]?.cwd
      if (typeof cwd === 'string' && cwd.trim()) {
        return normalizeDriveRootPathForPlatform(cwd)
      }
    }

    return fallbackProjectDir ? this.desanitizePath(fallbackProjectDir) : null
  }

  private resolveRepositoryFromEntries(entries: RawEntry[]): PreparedSessionWorkspace['repository'] | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const repository = (entries[i] as Record<string, unknown>)?.repository
      if (repository && typeof repository === 'object') {
        return repository as PreparedSessionWorkspace['repository']
      }
    }
    return undefined
  }

  private resolvePermissionModeFromEntries(entries: RawEntry[]): string | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry?.type !== 'session-meta') continue
      const permissionMode = entry.permissionMode
      if (
        typeof permissionMode === 'string' &&
        VALID_SESSION_PERMISSION_MODES.has(permissionMode)
      ) {
        return permissionMode
      }
    }
    return undefined
  }

  private resolveTranscriptModifiedAtFromEntries(entries: RawEntry[]): string | null {
    let modifiedAt: string | null = null
    for (const entry of entries) {
      if (
        !entry.isMeta &&
        (entry.type === 'user' || entry.type === 'assistant') &&
        entry.message?.role
      ) {
        modifiedAt = this.latestTimestamp(modifiedAt, entry.timestamp)
      }
    }
    return modifiedAt
  }

  private resolveRuntimeContextMetadataFromEntries(entries: RawEntry[]): ProviderContextWindowHint {
    let runtimeProviderId: string | null | undefined
    let runtimeModelId: string | undefined

    for (const entry of entries) {
      if (entry.type !== 'session-meta') continue
      const record = entry as Record<string, unknown>
      if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
        runtimeProviderId = record.runtimeProviderId as string | null
      }
      if (typeof record.runtimeModelId === 'string') {
        runtimeModelId = record.runtimeModelId
      }
    }

    return {
      ...(runtimeProviderId !== undefined ? { runtimeProviderId } : {}),
      ...(runtimeModelId ? { runtimeModelId } : {}),
    }
  }

  private applyRuntimeContextMetadata(
    hint: ProviderContextWindowHint,
    entry: RawEntry,
  ): ProviderContextWindowHint {
    if (entry.type !== 'session-meta') return hint

    const record = entry as Record<string, unknown>
    const nextHint: ProviderContextWindowHint = { ...hint }
    if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
      nextHint.runtimeProviderId = record.runtimeProviderId as string | null
    }
    if (typeof record.runtimeModelId === 'string') {
      nextHint.runtimeModelId = record.runtimeModelId
    }
    return nextHint
  }

  private resolveWorktreeSessionFromEntries(entries: RawEntry[]): PersistedWorktreeSession | null | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry?.type !== 'worktree-state') continue

      const worktreeSession = entry.worktreeSession
      if (worktreeSession === null) return null
      if (
        worktreeSession &&
        typeof worktreeSession === 'object' &&
        typeof worktreeSession.worktreePath === 'string' &&
        typeof worktreeSession.worktreeName === 'string'
      ) {
        return worktreeSession
      }
    }
    return undefined
  }

  private async resolveProjectRootFromEntries(
    entries: RawEntry[],
    workDir: string | null,
    fallbackProjectDir?: string,
  ): Promise<string | null> {
    const worktreeSession = this.resolveWorktreeSessionFromEntries(entries)
    const repository = this.resolveRepositoryFromEntries(entries)
    return this.resolveProjectRootFromSessionMetadata({
      worktreeSession,
      repository,
      workDir,
      fallbackProjectDir,
    })
  }

  private async resolveProjectRootFromSessionMetadata({
    worktreeSession,
    repository,
    workDir,
    fallbackProjectDir,
  }: {
    worktreeSession?: PersistedWorktreeSession | null
    repository?: PreparedSessionWorkspace['repository']
    workDir: string | null
    fallbackProjectDir?: string
  }): Promise<string | null> {
    const candidate = worktreeSession?.originalCwd ||
      repository?.repoRoot ||
      workDir ||
      (fallbackProjectDir ? this.desanitizePath(fallbackProjectDir) : null)

    if (!candidate) return null

    const canonicalCandidate = await this.canonicalizeProjectPath(candidate)
    const gitRoot = findCanonicalGitRoot(canonicalCandidate)
    if (gitRoot) return gitRoot

    if (workDir) {
      const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`
      const markerIndex = canonicalCandidate.indexOf(marker)
      if (markerIndex > 0) return canonicalCandidate.slice(0, markerIndex)
    }

    return canonicalCandidate
  }

  private async canonicalizeProjectPath(projectPath: string): Promise<string> {
    try {
      return normalizeDriveRootPathForPlatform(await fs.realpath(projectPath)).normalize('NFC')
    } catch {
      return projectPath.normalize('NFC')
    }
  }

  private countTranscriptMessages(entries: RawEntry[]): number {
    return entries.filter((entry) =>
      !entry.isMeta &&
      !!entry.message?.role &&
      (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system')
    ).length
  }

  /** A real conversation, including a collaboration delivery persisted as isMeta. */
  private hasConversationTranscript(entries: RawEntry[]): boolean {
    return entries.some((entry) => {
      if (!entry.message?.role) return false
      if (entry.type !== 'user' && entry.type !== 'assistant' && entry.type !== 'system') return false
      if (!entry.isMeta) return true
      return entry.type === 'user' && parseSessionCollaborationEnvelope(entry.message.content) !== null
    })
  }

  // --------------------------------------------------------------------------
  // Entry → MessageEntry conversion
  // --------------------------------------------------------------------------

  private entryToMessage(
    entry: RawEntry,
    parentToolUseId?: string,
  ): MessageEntry | null {
    const msg = entry.message
    if (!msg || !msg.role) return null

    // Determine our normalized type
    let type: MessageEntry['type']
    const role = msg.role

    if (role === 'user') {
      // Check if the content is a tool_result array
      if (Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(
          (block: Record<string, unknown>) => block.type === 'tool_result'
        )
        if (hasToolResult) {
          type = 'tool_result'
        } else {
          type = 'user'
        }
      } else {
        type = 'user'
      }
    } else if (role === 'assistant') {
      // Check if the content contains tool_use blocks
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some(
          (block: Record<string, unknown>) => block.type === 'tool_use'
        )
        type = hasToolUse ? 'tool_use' : 'assistant'
      } else {
        type = 'assistant'
      }
    } else {
      type = 'system'
    }

    const usage = isForkInheritedUsageRecord(entry)
      ? undefined
      : normalizeMessageUsage(msg.usage)
    const usageKey = usage
      ? usageRecordKey({
          version: entry.version,
          sessionId: entry.sessionId,
          requestId: entry.requestId,
          messageId: entry.message?.id,
        }) ?? undefined
      : undefined

    let content = msg.content
    let sessionReferences: { sessionId: string }[] | undefined
    let collaboration: { sourceSessionId: string; messageId: string } | undefined
    if (type === 'user') {
      const envelope = parseSessionCollaborationEnvelope(content)
      if (envelope) {
        // Render only the payload; the prompt wrapper is model-facing transport.
        content = envelope.text
        collaboration = { sourceSessionId: envelope.senderSessionId, messageId: envelope.messageId }
      } else if (typeof content === 'string') {
        const parsed = splitSessionReferenceContext(content)
        content = parsed.content
        sessionReferences = parsed.sessionReferences
      } else if (Array.isArray(content)) {
        content = content.map((block: Record<string, unknown>) => {
          if (block.type !== 'text' || typeof block.text !== 'string') return block
          const parsed = splitSessionReferenceContext(block.text)
          if (parsed.sessionReferences) sessionReferences = parsed.sessionReferences
          return { ...block, text: parsed.content }
        })
      }
    }
    return {
      id: entry.uuid || crypto.randomUUID(),
      type,
      content,
      ...(sessionReferences ? { sessionReferences } : {}),
      ...(collaboration ? { collaboration } : {}),
      ...(entry.bodyTruncated === true ? { bodyTruncated: true } : {}),
      ...(entry.toolUseResult !== undefined ? { toolUseResult: entry.toolUseResult } : {}),
      timestamp: entry.timestamp || new Date().toISOString(),
      model: msg.model,
      ...(usage ? { usage } : {}),
      ...(usageKey ? { usageKey } : {}),
      parentUuid: entry.parentUuid ?? undefined,
      parentToolUseId,
      isSidechain: entry.isSidechain,
      ...(typeof entry.cwd === 'string' && entry.cwd.trim() ? { cwd: entry.cwd } : {}),
    }
  }

  private extractTextBlocks(content: unknown): string[] {
    if (typeof content === 'string') return [content]
    if (!Array.isArray(content)) return []

    return content
      .flatMap((block) => {
        if (!block || typeof block !== 'object') return []
        const record = block as Record<string, unknown>
        return record.type === 'text' && typeof record.text === 'string'
          ? [record.text]
          : []
      })
      .map((text) => text.trim())
      .filter(Boolean)
  }

  private isSyntheticUserInterruption(content: unknown): boolean {
    const textBlocks = this.extractTextBlocks(content)
    return (
      textBlocks.length > 0 &&
      textBlocks.every((text) => USER_INTERRUPTION_TEXTS.has(text))
    )
  }

  private isSyntheticNoResponseAssistant(content: unknown): boolean {
    const textBlocks = this.extractTextBlocks(content)
    return (
      textBlocks.length > 0 &&
      textBlocks.every((text) => text === NO_RESPONSE_REQUESTED_TEXT)
    )
  }

  private isToolResultContent(content: unknown): boolean {
    return (
      Array.isArray(content) &&
      content.some((block) =>
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_result'
      )
    )
  }

  private isTaskNotificationContent(content: unknown): boolean {
    const textBlocks = this.extractTextBlocks(content)
    return (
      textBlocks.length > 0 &&
      textBlocks.every((text) => this.extractTaskNotificationXml(text) !== null)
    )
  }

  private extractTaskNotificationXml(text: string): string | null {
    const trimmed = text.trim()
    if (TASK_NOTIFICATION_RE.test(trimmed)) return trimmed
    return trimmed.match(TASK_NOTIFICATION_BLOCK_RE)?.[0] ?? null
  }

  private decodeXmlText(text: string): string {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  }

  private readXmlTag(xml: string, tag: string): string | undefined {
    const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
    return match?.[1] ? this.decodeXmlText(match[1].trim()) : undefined
  }

  private parseTaskNotificationContent(
    content: unknown,
    timestamp?: string,
  ): SessionTaskNotification | null {
    const xml = this.extractTextBlocks(content)
      .map((text) => this.extractTaskNotificationXml(text))
      .find((value): value is string => value !== null)
    if (!xml) return null

    const toolUseId = this.readXmlTag(xml, 'tool-use-id')
    const rawStatus = this.readXmlTag(xml, 'status')
    const status = rawStatus === 'killed' ? 'stopped' : rawStatus
    if (
      !toolUseId ||
      (status !== 'completed' && status !== 'failed' && status !== 'stopped')
    ) {
      return null
    }

    const taskId = this.readXmlTag(xml, 'task-id') || toolUseId
    const workflowRunId = this.readXmlTag(xml, 'workflow-run-id')
    const summary = this.readXmlTag(xml, 'summary')
    const result = this.readXmlTag(xml, 'result')
    const outputFile = this.readXmlTag(xml, 'output-file')
    const ownerAgentId = this.readXmlTag(xml, 'owner-agent-id')
    return {
      taskId,
      toolUseId,
      ...(ownerAgentId ? { ownerAgentId } : {}),
      status,
      ...(workflowRunId ? { workflowRunId } : {}),
      ...(summary ? { summary } : {}),
      ...(result ? { result } : {}),
      ...(outputFile ? { outputFile } : {}),
      ...(timestamp ? { timestamp } : {}),
    }
  }

  private parsePersistedTaskNotification(
    value: unknown,
    timestamp?: string,
  ): SessionTaskNotification | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const notification = value as Record<string, unknown>
    const toolUseId = typeof notification.toolUseId === 'string'
      ? notification.toolUseId
      : null
    const status = notification.status
    if (
      !toolUseId ||
      (status !== 'completed' && status !== 'failed' && status !== 'stopped')
    ) {
      return null
    }

    const optionalString = (key: string) =>
      typeof notification[key] === 'string' && notification[key]
        ? notification[key] as string
        : undefined
    const workflowRunId = optionalString('workflowRunId')
    return {
      taskId: optionalString('taskId') ?? toolUseId,
      toolUseId,
      ...(optionalString('ownerAgentId')
        ? { ownerAgentId: optionalString('ownerAgentId') }
        : {}),
      status,
      ...(workflowRunId ? { workflowRunId } : {}),
      ...(optionalString('summary') ? { summary: optionalString('summary') } : {}),
      ...(optionalString('result') ? { result: optionalString('result') } : {}),
      ...(optionalString('outputFile') ? { outputFile: optionalString('outputFile') } : {}),
      ...(timestamp ? { timestamp } : {}),
    }
  }

  private shouldHideTranscriptEntry(entry: RawEntry): boolean {
    const role = entry.message?.role
    const content = entry.message?.content

    if (role === 'user') {
      return (
        shouldHideCommandMetadataContent(content) ||
        this.isSyntheticUserInterruption(content) ||
        this.isTaskNotificationContent(content)
      )
    }

    if (role === 'assistant') {
      return this.isSyntheticNoResponseAssistant(content)
    }

    return false
  }

  private isVisibleTranscriptMessageEntry(entry: RawEntry): boolean {
    if (!entry.message?.role) return false
    // Collaboration deliveries are persisted as isMeta prompts; they carry a real
    // cross-session message the user must see, so they are the one exception.
    if (entry.isMeta && !parseSessionCollaborationEnvelope(entry.message.content)) return false
    if (
      entry.type !== 'user' &&
      entry.type !== 'assistant' &&
      entry.type !== 'system'
    ) {
      return false
    }
    return !this.shouldHideTranscriptEntry(entry)
  }

  private isGoalLocalCommandOutput(output: string): boolean {
    const trimmed = output.trim()
    return (
      trimmed.startsWith('Goal set:') ||
      trimmed.startsWith('Goal continuing:') ||
      trimmed.startsWith('Goal cleared:') ||
      trimmed === 'Goal cleared.' ||
      trimmed === 'Goal marked complete.' ||
      trimmed === 'No active goal.'
    )
  }

  private isGoalLocalCommandEntry(entry: RawEntry): boolean {
    if (
      entry.type !== 'system' ||
      entry.subtype !== 'local_command' ||
      typeof entry.content !== 'string'
    ) {
      return false
    }

    const commandName = this.readXmlTag(entry.content, 'command-name')?.replace(/^\//, '')
    if (commandName) return commandName === 'goal'

    const output =
      this.readXmlTag(entry.content, 'local-command-stdout') ??
      this.readXmlTag(entry.content, 'local-command-stderr')
    return output ? this.isGoalLocalCommandOutput(output) : false
  }

  private goalLocalCommandEntryToMessage(entry: RawEntry): MessageEntry | null {
    if (!this.isGoalLocalCommandEntry(entry)) return null
    return {
      id: entry.uuid || crypto.randomUUID(),
      type: 'system',
      content: entry.content,
      timestamp: entry.timestamp || new Date().toISOString(),
      parentUuid: entry.parentUuid ?? undefined,
      isSidechain: entry.isSidechain,
    }
  }

  private extractAgentToolUseId(entry: RawEntry): string | undefined {
    const content = entry.message?.content
    if (!Array.isArray(content)) return undefined

    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block.type === 'tool_use' &&
        (block.name === 'Agent' || block.name === 'Task') &&
        typeof block.id === 'string'
      ) {
        return block.id
      }
    }

    return undefined
  }

  private extractAgentToolUseIdsFromMessage(message: MessageEntry): string[] {
    if (message.type !== 'tool_use' || !Array.isArray(message.content)) {
      return []
    }

    return (message.content as ContentBlock[])
      .filter((block) =>
        block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')
      )
      .flatMap((block) => (typeof block.id === 'string' ? [block.id] : []))
  }

  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''

    return (content as ContentBlock[])
      .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
      .join('\n')
  }

  private extractAgentIdFromResultText(text: string): string | undefined {
    const match = text.match(/(?:^|\n)\s*agentId:\s*([A-Za-z0-9_-]+)/)
    return match?.[1]
  }

  private extractAgentResultLinks(messages: MessageEntry[]): Map<string, string> {
    const agentToolUseIds = new Set(
      messages.flatMap((message) => this.extractAgentToolUseIdsFromMessage(message)),
    )
    const resultLinks = new Map<string, string>()

    for (const message of messages) {
      if (message.type !== 'tool_result' || !Array.isArray(message.content)) {
        continue
      }

      for (const block of message.content as ContentBlock[]) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
          continue
        }
        if (!agentToolUseIds.has(block.tool_use_id)) {
          continue
        }

        const agentId = this.extractAgentIdFromResultText(
          this.extractTextFromContent(block.content),
        )
        if (agentId) {
          resultLinks.set(block.tool_use_id, agentId)
        }
      }
    }

    return resultLinks
  }

  private namespaceSubagentContentIds(content: unknown, namespace: string): unknown {
    if (!Array.isArray(content)) return content

    return (content as ContentBlock[]).map((block) => {
      if (!block || typeof block !== 'object') return block
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        return {
          ...block,
          id: `${namespace}/${block.id}`,
          original_tool_use_id: block.id,
        }
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        return {
          ...block,
          tool_use_id: `${namespace}/${block.tool_use_id}`,
          original_tool_use_id: block.tool_use_id,
        }
      }
      return block
    })
  }

  private subagentTranscriptPath(
    projectDir: string,
    sessionId: string,
    agentId: string,
  ): string {
    const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
    return path.join(
      this.getProjectsDir(),
      projectDir,
      sessionId,
      'subagents',
      `${normalizedAgentId}.jsonl`,
    )
  }

  private async loadSubagentToolMessages(
    projectDir: string,
    sessionId: string,
    parentToolUseId: string,
    agentId: string,
  ): Promise<SubagentMessagesResult> {
    const filePath = this.subagentTranscriptPath(projectDir, sessionId, agentId)
    const { entries, exists, parseComplete } = await this.readJsonlFileWithDiagnostics(filePath)
    const namespace = `${parentToolUseId}/${agentId}`
    const messages: MessageEntry[] = []

    for (const entry of entries) {
      if (!entry.message?.role || entry.isMeta) continue
      if (this.shouldHideTranscriptEntry(entry)) continue
      if (entry.type !== 'user' && entry.type !== 'assistant' && entry.type !== 'system') {
        continue
      }

      const message = this.entryToMessage(
        {
          ...entry,
          message: {
            ...entry.message,
            content: this.namespaceSubagentContentIds(entry.message.content, namespace),
          },
        },
        parentToolUseId,
      )
      if (message && (message.type === 'tool_use' || message.type === 'tool_result')) {
        messages.push(message)
      }
    }

    return {
      messages,
      subagentEvidenceComplete: exists && parseComplete,
    }
  }

  private async appendSubagentToolMessages(
    projectDir: string,
    sessionId: string,
    messages: MessageEntry[],
  ): Promise<SubagentMessagesResult> {
    const maxSubagentDepth = 16
    const maxSubagentTranscripts = 128
    const maxSubagentMessages = 20_000
    type PendingLink = {
      parentToolUseId: string
      agentId: string
      depth: number
      ancestry: Set<string>
    }
    const transcriptIdentity = (agentId: string) => {
      const transcriptPath = path.resolve(
        this.subagentTranscriptPath(projectDir, sessionId, agentId),
      )
      return process.platform === 'win32' ? transcriptPath.toLowerCase() : transcriptPath
    }

    const allMessages = [...messages]
    const loadedLinks = new Set<string>()
    let loadedTranscriptCount = 0
    let loadedMessageCount = 0
    let subagentEvidenceComplete = true
    const initialResultLinks = this.extractAgentResultLinks(messages)
    if (messages.some((message) =>
      this.extractAgentToolUseIdsFromMessage(message).some((id) => !initialResultLinks.has(id))
    )) {
      subagentEvidenceComplete = false
    }
    let pendingLinks: PendingLink[] = [...initialResultLinks.entries()]
      .map(([parentToolUseId, agentId]) => ({
        parentToolUseId,
        agentId,
        depth: 1,
        ancestry: new Set<string>(),
      }))

    while (pendingLinks.length > 0) {
      const newLinks = pendingLinks.filter(({ parentToolUseId, agentId, depth, ancestry }) => {
        const identity = transcriptIdentity(agentId)
        if (ancestry.has(identity)) {
          return false
        }
        if (depth > maxSubagentDepth || loadedTranscriptCount >= maxSubagentTranscripts) {
          subagentEvidenceComplete = false
          return false
        }
        const key = `${parentToolUseId}\u0000${agentId}`
        if (loadedLinks.has(key)) return false
        loadedLinks.add(key)
        loadedTranscriptCount += 1
        return true
      })
      if (newLinks.length === 0) break

      const loadedChildren = await Promise.all(
        newLinks.map(async (link) => ({
          link,
          result: await this.loadSubagentToolMessages(
            projectDir,
            sessionId,
            link.parentToolUseId,
            link.agentId,
          ),
        })),
      )
      pendingLinks = []
      for (const { link, result } of loadedChildren) {
        const childMessages = result.messages
        if (!result.subagentEvidenceComplete) subagentEvidenceComplete = false
        const remainingMessageCapacity = maxSubagentMessages - loadedMessageCount
        if (remainingMessageCapacity <= 0) {
          subagentEvidenceComplete = false
          break
        }
        const acceptedMessages = childMessages.slice(0, remainingMessageCapacity)
        if (acceptedMessages.length < childMessages.length) {
          subagentEvidenceComplete = false
        }
        loadedMessageCount += acceptedMessages.length
        allMessages.push(...acceptedMessages)

        const ancestry = new Set(link.ancestry)
        ancestry.add(transcriptIdentity(link.agentId))
        const childResultLinks = this.extractAgentResultLinks(acceptedMessages)
        if (acceptedMessages.some((message) =>
          this.extractAgentToolUseIdsFromMessage(message)
            .some((id) => !childResultLinks.has(id))
        )) {
          subagentEvidenceComplete = false
        }
        for (const [parentToolUseId, agentId] of childResultLinks) {
          pendingLinks.push({
            parentToolUseId,
            agentId,
            depth: link.depth + 1,
            ancestry,
          })
        }
      }
    }

    return { messages: allMessages, subagentEvidenceComplete }
  }

  private resolveParentToolUseId(
    entry: RawEntry,
    entriesByUuid: Map<string, RawEntry>,
    cache: Map<string, string | undefined>,
  ): string | undefined {
    if (
      typeof entry.parent_tool_use_id === 'string' &&
      entry.parent_tool_use_id.length > 0
    ) {
      return entry.parent_tool_use_id
    }

    if (entry.isSidechain !== true) {
      return undefined
    }

    const cacheKey = entry.uuid
    if (cacheKey && cache.has(cacheKey)) {
      return cache.get(cacheKey)
    }

    let resolved: string | undefined
    let currentParentUuid =
      typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined
    const visited = new Set<string>()

    while (currentParentUuid && !visited.has(currentParentUuid)) {
      visited.add(currentParentUuid)
      const parentEntry = entriesByUuid.get(currentParentUuid)
      if (!parentEntry) break

      const directAgentToolUseId = this.extractAgentToolUseId(parentEntry)
      if (directAgentToolUseId) {
        resolved = directAgentToolUseId
        break
      }

      if (parentEntry.uuid && cache.has(parentEntry.uuid)) {
        resolved = cache.get(parentEntry.uuid)
        break
      }

      currentParentUuid =
        typeof parentEntry.parentUuid === 'string'
          ? parentEntry.parentUuid
          : undefined
    }

    if (cacheKey) {
      cache.set(cacheKey, resolved)
    }

    return resolved
  }

  // --------------------------------------------------------------------------
  // Title extraction
  // --------------------------------------------------------------------------

  private extractTitle(entries: RawEntry[]): string {
    // 1. Look for custom title entry (appended by renameSession) — highest priority
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (e.type === 'custom-title' && e.customTitle) {
        return e.customTitle
      }
    }

    // 2. Goal sessions should keep the original objective as the stable title.
    for (const e of entries) {
      const goalTitle = extractGoalCreationTitle(e)
      if (goalTitle) return goalTitle
    }

    // 3. Look for AI-generated title (written by titleService)
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (e.type === 'ai-title' && e.aiTitle) {
        const title = cleanSessionTitleSource(String(e.aiTitle))
        if (title) return title
      }
    }

    // 4. Look for first non-meta user message as title
    for (const e of entries) {
      if (e.type === 'user' && !e.isMeta && e.message?.role === 'user') {
        const title = extractTranscriptUserTitle(e.message.content)
        if (title) return title
      }
    }

    return 'Untitled Session'
  }

  // --------------------------------------------------------------------------
  // Session file discovery
  // --------------------------------------------------------------------------

  /**
   * Find all .jsonl session files across all project directories.
   * Returns an array of { filePath, projectDir, sessionId }.
   */
  private async discoverSessionFiles(projectFilter?: string, scope = this.getConfigDir()): Promise<
    Array<{ filePath: string; projectDir: string; sessionId: string }>
  > {
    const projectsDir = path.join(scope, 'projects')
    let projectDirs: string[]

    try {
      projectDirs = await fs.readdir(projectsDir)
    } catch {
      return []
    }

    // Optionally filter to a specific project
    if (projectFilter) {
      const sanitized = this.sanitizePath(normalizeDriveRootPathForPlatform(projectFilter))
      projectDirs = projectDirs.filter((d) => d === sanitized)
    }

    const results: Array<{ filePath: string; projectDir: string; sessionId: string }> = []

    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir)

      // Ensure it's a directory
      try {
        const stat = await fs.stat(dirPath)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      let files: string[]
      try {
        files = await fs.readdir(dirPath)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.replace('.jsonl', '')
        results.push({
          filePath: path.join(dirPath, file),
          projectDir: dir,
          sessionId,
        })
      }
    }

    return results
  }

  /**
   * Convert a sanitized directory name back to the original absolute path.
   * Reverses sanitizePath(): `-Users-nanmi-workspace` → `/Users/nanmi/workspace`.
   */
  desanitizePath(sanitized: string): string {
    // The sanitized form replaces all non-alphanumeric characters with '-'.
    // This fallback is necessarily lossy, but old Windows transcripts without
    // session-meta still need the drive separator restored well enough to resume.
    const windowsDrivePath = sanitized.match(/^([a-zA-Z])--(.+)$/)
    if (windowsDrivePath) {
      return `${windowsDrivePath[1]}:${path.win32.sep}${windowsDrivePath[2].replace(/-/g, path.win32.sep)}`
    }

    const windowsDriveRoot = sanitized.match(/^([a-zA-Z])--$/)
    if (windowsDriveRoot) {
      return `${windowsDriveRoot[1]}:${path.win32.sep}`
    }

    // On POSIX the original path starts with '/', so the sanitized form starts with '-'.
    // UNC-style Windows paths also recover to a leading double separator on Windows.
    return sanitized.replace(/-/g, path.sep)
  }

  /**
   * Find the .jsonl file for a given session ID.
   * Searches across all project directories since sessions may belong to any project.
   */
  private async validateIndexedTranscriptPath(
    filePath: string,
    projectDir: string,
    sessionId: string,
    projectsRoot: string,
  ): Promise<Stats> {
    const invalid = (): Error & { code: string } => Object.assign(
      new Error('Indexed transcript path failed scope validation'),
      { code: 'LOCAL_INDEX_PATH_INVALID' },
    )
    if (
      !this.isValidSessionId(sessionId) ||
      !projectDir ||
      path.basename(projectDir) !== projectDir ||
      path.basename(filePath) !== `${sessionId}.jsonl` ||
      path.basename(path.dirname(filePath)) !== projectDir
    ) {
      throw invalid()
    }

    const projectsDir = this.getProjectsDir()
    const expectedPath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`)
    const indexedRealPath = await fs.realpath(filePath)
    const expectedRealPath = path.resolve(expectedPath) === path.resolve(filePath)
      ? indexedRealPath
      : await fs.realpath(expectedPath)
    const relativePath = path.relative(projectsRoot, indexedRealPath)
    if (
      expectedRealPath !== indexedRealPath ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw invalid()
    }

    const stat = await fs.stat(indexedRealPath)
    if (!stat.isFile()) throw invalid()
    return stat
  }

  private async findSessionFiles(
    sessionId: string
  ): Promise<Array<{ filePath: string; projectDir: string }>> {
    this.syncSharedMutationEpoch()
    if (!this.isValidSessionId(sessionId)) {
      return []
    }

    const indexMode = this.getUsableIndexMode()
    if (indexMode === 'on') {
      const indexedMutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
      try {
        const indexedMatches = this.localIndexGateway.findSessionFiles(sessionId)
        if (!this.indexStatusRemainsUsable()) {
          this.markIndexReadFailure()
        } else {
          const projectsRoot = indexedMatches.length > 0
            ? await fs.realpath(this.getProjectsDir())
            : null
          const hydratedMatches: Array<SessionFileMatch & { mtimeMs: number; hasTranscript: boolean }> = []
          let hydrationFailed = false
          for (const match of indexedMatches) {
            try {
              const stat = await this.validateIndexedTranscriptPath(
                match.filePath,
                match.projectDir,
                sessionId,
                projectsRoot!,
              )
              const entries = await this.readJsonlFile(match.filePath)
              hydratedMatches.push({
                ...match,
                mtimeMs: stat.mtimeMs,
                hasTranscript: this.hasConversationTranscript(entries),
              })
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                hydrationFailed = true
                break
              }
            }
          }
          if (
            !hydrationFailed &&
            hydratedMatches.length > 0 &&
            indexedMutationEpoch === getSharedSessionMutationState(this.localIndexGateway).epoch
          ) {
            return hydratedMatches
              .sort((a, b) => Number(b.hasTranscript) - Number(a.hasTranscript) || b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
              .map(({ filePath, projectDir }) => ({ filePath, projectDir }))
          }
          if (hydrationFailed) this.markIndexReadFailure()
        }
      } catch {
        this.markIndexReadFailure()
      }
    }

    this.syncSharedMutationEpoch()
    return this.findSessionFilesFromFiles(sessionId)
  }

  private async findSessionFilesFromFiles(
    sessionId: string,
  ): Promise<Array<{ filePath: string; projectDir: string }>> {

    const projectsDir = this.getProjectsDir()
    let projectDirs: string[]

    try {
      projectDirs = await fs.readdir(projectsDir)
    } catch {
      return []
    }

    const matches: Array<{ filePath: string; projectDir: string; mtimeMs: number; hasTranscript: boolean }> = []
    for (const dir of projectDirs) {
      const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`)
      try {
        const stat = await fs.stat(filePath)
        const entries = await this.readJsonlFile(filePath)
        matches.push({
          filePath,
          projectDir: dir,
          mtimeMs: stat.mtimeMs,
          hasTranscript: this.hasConversationTranscript(entries),
        })
      } catch {
        continue
      }
    }

    return matches
      .sort((a, b) => Number(b.hasTranscript) - Number(a.hasTranscript) || b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
      .map(({ filePath, projectDir }) => ({ filePath, projectDir }))
  }

  async findSessionFile(
    sessionId: string
  ): Promise<{ filePath: string; projectDir: string } | null> {
    return (await this.findSessionFiles(sessionId))[0] ?? null
  }

  private isValidSessionId(id: string): boolean {
    // UUID v4 format
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  }

  private formatCost(cost: number): string {
    return `$${cost > 0.5 ? (Math.round(cost * 100) / 100).toFixed(2) : cost.toFixed(4)}`
  }

  private async getProviderContextWindowForSession(
    sessionId: string,
    model: string,
    launchInfoOverride?: ProviderContextWindowHint | null,
  ): Promise<number | undefined> {
    const launchInfo = launchInfoOverride ?? await this.getSessionLaunchInfo(sessionId).catch(() => null)
    const providerIds: string[] = []
    const allowSavedProviderInference = launchInfo?.runtimeProviderId === undefined

    if (typeof launchInfo?.runtimeProviderId === 'string') {
      providerIds.push(launchInfo.runtimeProviderId)
    } else if (launchInfo?.runtimeProviderId !== null) {
      const { activeId } = await this.providerService.listProviders().catch(() => ({ activeId: null }))
      if (activeId) providerIds.push(activeId)
    }

    // Provider env model keys — these are the configured model names that
    // should be used as fallback matching keys when the transcript model name
    // (from the API response) doesn't match the modelContextWindows keys.
    // Third-party APIs may return model names with provider-specific suffixes
    // (e.g. "LongCat-2.0-Preview-LongCatAI" instead of "LongCat-2.0-Preview").
    const providerEnvModelKeys = [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ] as const

    for (const providerId of providerIds) {
      const env = await this.providerService.getProviderRuntimeEnv(providerId).catch(() => null)
      const rawContextWindows = env?.[MODEL_CONTEXT_WINDOWS_ENV_KEY] ?? null
      // Step 1: Try matching the transcript model name directly (current behavior)
      const contextWindow = getModelContextWindowFromEnvValue(
        model,
        rawContextWindows,
      )
      if (contextWindow !== undefined) {
        if (contextWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
          return MODEL_CONTEXT_WINDOW_DEFAULT
        }
        return contextWindow
      }

      // Step 2: Prefer the model this session actually launched with. Some
      // third-party APIs return provider-specific aliases, but Desktop persists
      // the requested runtime model in session metadata.
      if (launchInfo?.runtimeModelId) {
        const runtimeModelWindow = getModelContextWindowFromEnvValue(
          launchInfo.runtimeModelId,
          rawContextWindows,
        )
        if (runtimeModelWindow !== undefined) {
          if (runtimeModelWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
            return MODEL_CONTEXT_WINDOW_DEFAULT
          }
          return runtimeModelWindow
        }
      }

      // Step 3: If transcript model name didn't match, try matching with
      // the provider's configured model names as fallback keys.
      // This handles the case where the API response returns a model name
      // that differs from the user-configured model name (e.g. provider
      // appends its own suffix like "-LongCatAI").
      if (env && rawContextWindows) {
        for (const envKey of providerEnvModelKeys) {
          const configuredModel = env[envKey]
          if (!configuredModel) continue
          if (!providerModelLooksRelated(model, configuredModel)) continue
          const fallbackWindow = getModelContextWindowFromEnvValue(
            configuredModel,
            rawContextWindows,
          )
          if (fallbackWindow !== undefined) {
            if (fallbackWindow > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
              return MODEL_CONTEXT_WINDOW_DEFAULT
            }
            return fallbackWindow
          }
        }
      }
    }

    if (allowSavedProviderInference) {
      return this.getUniqueSavedProviderContextWindow(model)
    }

    return undefined
  }

  private async getUniqueSavedProviderContextWindow(model: string): Promise<number | undefined> {
    const { providers } = await this.providerService.listProviders().catch(() => ({ providers: [] }))
    const matches: number[] = []
    const providerEnvModelKeys = [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ] as const

    for (const provider of providers) {
      const env = await this.providerService.getProviderRuntimeEnv(provider.id).catch(() => null)
      const rawContextWindows = env?.[MODEL_CONTEXT_WINDOWS_ENV_KEY] ?? null
      // Step 1: Try matching the transcript model name directly
      const contextWindow = getModelContextWindowFromEnvValue(
        model,
        rawContextWindows,
      )
      if (contextWindow !== undefined) {
        matches.push(contextWindow)
        continue
      }

      // Step 2: Fallback to provider configured model names.
      if (env && rawContextWindows) {
        for (const envKey of providerEnvModelKeys) {
          const configuredModel = env[envKey]
          if (!configuredModel) continue
          if (!providerModelLooksRelated(model, configuredModel)) continue
          const fallbackWindow = getModelContextWindowFromEnvValue(
            configuredModel,
            rawContextWindows,
          )
          if (fallbackWindow !== undefined) {
            matches.push(fallbackWindow)
            break // One match per provider is enough
          }
        }
      }
    }

    if (matches.length === 0) {
      return undefined
    }

    const uniqueWindows = new Set(matches)
    if (uniqueWindows.size !== 1) {
      return undefined
    }

    const contextWindow = [...uniqueWindows][0]!
    if (
      contextWindow > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return contextWindow
  }

  private async getTranscriptContextWindow(
    sessionId: string,
    model: string,
    launchInfo?: ProviderContextWindowHint | null,
  ): Promise<number> {
    const providerContextWindow = await this.getProviderContextWindowForSession(
      sessionId,
      model,
      launchInfo,
    )
    if (providerContextWindow !== undefined) {
      return providerContextWindow
    }

    try {
      return getContextWindowForModel(model)
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('Config accessed before allowed')
      ) {
        return MODEL_CONTEXT_WINDOW_DEFAULT
      }
      throw err
    }
  }

  async getTranscriptMetadata(sessionId: string): Promise<TranscriptMetadataSnapshot | null> {
    return (await this.getInspectionTranscriptSnapshot(sessionId))?.metadata ?? null
  }

  private async buildTranscriptContextEstimate(
    sessionId: string,
    latest: {
      model: string
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
    },
    estimatedTokensFromMessages: number,
    estimatedTokensAfterUsage: number,
    transcriptHasMediaInput: boolean,
    launchInfo?: ProviderContextWindowHint | null,
  ): Promise<TranscriptContextEstimate> {
    const rawMaxTokens = await this.getTranscriptContextWindow(sessionId, latest.model, launchInfo)
    const promptTokens = latest.inputTokens + latest.cacheReadInputTokens + latest.cacheCreationInputTokens
    const providerTokens = promptTokens + latest.outputTokens
    const hasProviderUsage = providerTokens > 0
    const estimatedTokens = estimatedTokensFromMessages || promptTokens
    const contextBudget = calculateContextBudget({
      estimatedTokens,
      contextWindow: rawMaxTokens,
      currentUsage: {
        input_tokens: latest.inputTokens,
        output_tokens: latest.outputTokens,
        cache_read_input_tokens: latest.cacheReadInputTokens,
        cache_creation_input_tokens: latest.cacheCreationInputTokens,
      },
      usageTrust: getProviderUsageTrust({
        isFirstPartyAnthropic: isFirstPartyAnthropicBaseUrl(),
      }),
      hasMediaInput: transcriptHasMediaInput,
    })
    const totalTokens =
      hasProviderUsage && !contextBudget.ignoredUsageReason
        ? Math.min(
            Math.max(
              contextBudget.usedTokens,
              providerTokens + estimatedTokensAfterUsage,
            ),
            rawMaxTokens,
          )
        : contextBudget.usedTokens
    const percentage = rawMaxTokens > 0 ? Math.round((totalTokens / rawMaxTokens) * 100) : 0
    const usageCategories: TranscriptContextEstimate['categories'] = [
      { name: 'Input tokens', tokens: latest.inputTokens, color: '#8f3217' },
      { name: 'Cache read', tokens: latest.cacheReadInputTokens, color: '#0f5c8f' },
      { name: 'Cache write', tokens: latest.cacheCreationInputTokens, color: '#7c3aed' },
      { name: 'Output tokens', tokens: latest.outputTokens, color: '#2f7d32' },
    ]
    const contextCategories: TranscriptContextEstimate['categories'] =
      totalTokens === providerTokens
        ? usageCategories
        : [{ name: 'Estimated context', tokens: totalTokens, color: '#8f3217' }]
    const categories: TranscriptContextEstimate['categories'] = [
      ...contextCategories,
      { name: 'Free space', tokens: Math.max(0, rawMaxTokens - totalTokens), color: '#a1a1aa', isDeferred: true },
    ].filter((category) => category.tokens > 0)

    const filledSquares = Math.max(0, Math.min(100, Math.round((totalTokens / Math.max(1, rawMaxTokens)) * 100)))
    const gridRows = Array.from({ length: 10 }, (_, row) =>
      Array.from({ length: 10 }, (_, col) => {
        const index = row * 10 + col
        const isFilled = index < filledSquares
        return {
          color: isFilled ? '#8f3217' : '#a1a1aa',
          isFilled,
          categoryName: isFilled ? 'Input context' : 'Free space',
          tokens: Math.round(rawMaxTokens / 100),
          percentage: 1,
          squareFullness: isFilled ? 1 : 0,
        }
      }),
    )

    return {
      categories,
      totalTokens,
      maxTokens: rawMaxTokens,
      rawMaxTokens,
      percentage,
      gridRows,
      model: latest.model,
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      apiUsage: {
        input_tokens: latest.inputTokens,
        output_tokens: latest.outputTokens,
        cache_creation_input_tokens: latest.cacheCreationInputTokens,
        cache_read_input_tokens: latest.cacheReadInputTokens,
      },
    }
  }

  async getTranscriptContextEstimate(sessionId: string): Promise<TranscriptContextEstimate | null> {
    return (await this.getInspectionTranscriptSnapshot(sessionId))?.contextEstimate ?? null
  }

  async getTranscriptUsage(sessionId: string): Promise<TranscriptUsageSnapshot | null> {
    return (await this.getInspectionTranscriptSnapshot(sessionId))?.usage ?? null
  }

  async getInspectionTranscriptSnapshot(sessionId: string): Promise<SessionInspectionTranscriptSnapshot | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null
    const stat = await fs.stat(found.filePath, { bigint: true })
    // The transcript is immutable between polls, but its interpreted token budget
    // also depends on editable provider settings and process-level overrides.
    const providers = await this.providerService.listProviders().catch(() => null)
    const contextRevision = createHash('sha256').update(JSON.stringify({
      activeId: providers?.activeId,
      providers: providers?.providers.map(provider => ({
        id: provider.id,
        models: provider.models,
        modelContextWindows: provider.modelContextWindows,
        model1mSupport: provider.model1mSupport,
        autoCompactWindow: provider.autoCompactWindow,
      })),
      env: [
        MODEL_CONTEXT_WINDOWS_ENV_KEY, 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
        'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'USER_TYPE', 'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_AZURE_OPENAI',
      ].map(name => process.env[name] ?? null),
    })).digest('hex')
    const key = `${found.filePath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${contextRevision}`
    const existing = this.inspectionSnapshots.get(key)
    if (existing) return existing
    const request = (async () => {
      const snapshot = await this.readInspectionTranscriptSnapshot(sessionId)
      const after = await fs.stat(found.filePath, { bigint: true })
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
        throw ApiError.conflict('Transcript changed during inspection; retry the request')
      }
      if (snapshot && Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) {
        throw new ApiError(413, 'Transcript inspection exceeds its display budget', 'HISTORY_INSPECTION_LIMIT')
      }
      return snapshot
    })()
    this.inspectionSnapshots.set(key, request)
    while (this.inspectionSnapshots.size > 8) this.inspectionSnapshots.delete(this.inspectionSnapshots.keys().next().value!)
    try { return await request }
    catch (error) { this.inspectionSnapshots.delete(key); throw error }
  }

  private async readInspectionTranscriptSnapshot(sessionId: string): Promise<SessionInspectionTranscriptSnapshot | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    let latestWorkDir: string | null = null
    let latestCwd: string | null = null
    let repository: PreparedSessionWorkspace['repository'] | undefined
    let worktreeSession: PersistedWorktreeSession | null | undefined
    let permissionMode: string | undefined
    let runtimeProviderId: string | null | undefined
    let runtimeModelId: string | undefined
    let effortLevel: string | undefined
    let customTitle: string | null = null
    let transcriptMessageCount = 0
    const metadata: TranscriptMetadataSnapshot = {}

    const models = new Map<string, TranscriptUsageSnapshot['models'][number]>()
    const modelRuntimeHints = new Map<string, ProviderContextWindowHint>()
    let totalCostUSD = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadInputTokens = 0
    let totalCacheCreationInputTokens = 0
    let totalWebSearchRequests = 0
    let hasUnknownModelCost = false
    let firstUsageAt: number | null = null
    let lastUsageAt: number | null = null

    const contextState = createTranscriptContextAccumulator()
    const countedUsageKeys = new Set<string>()

    await this.streamJsonlFile(found.filePath, (entry) => {
      if (typeof entry.message?.model === 'string') {
        metadata.model = entry.message.model
      }
      if (typeof entry.cwd === 'string') {
        metadata.cwd = entry.cwd
        latestCwd = normalizeDriveRootPathForPlatform(entry.cwd)
      }
      if (typeof entry.version === 'string') {
        metadata.version = entry.version
      }

      if (entry.type === 'session-meta') {
        const record = entry as Record<string, unknown>
        if (typeof record.workDir === 'string') {
          latestWorkDir = normalizeDriveRootPathForPlatform(record.workDir)
        }
        if (
          typeof entry.permissionMode === 'string' &&
          VALID_SESSION_PERMISSION_MODES.has(entry.permissionMode)
        ) {
          permissionMode = entry.permissionMode
        }
        if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
          runtimeProviderId = record.runtimeProviderId as string | null
        }
        if (typeof record.runtimeModelId === 'string') {
          runtimeModelId = record.runtimeModelId
        }
        if (
          typeof record.effortLevel === 'string' &&
          VALID_SESSION_EFFORT_LEVELS.has(record.effortLevel)
        ) {
          effortLevel = record.effortLevel
        }
      }

      const candidateRepository = (entry as Record<string, unknown>)?.repository
      if (candidateRepository && typeof candidateRepository === 'object') {
        repository = candidateRepository as PreparedSessionWorkspace['repository']
      }

      if (entry.type === 'worktree-state') {
        if (entry.worktreeSession === null) {
          worktreeSession = null
        } else if (
          entry.worktreeSession &&
          typeof entry.worktreeSession === 'object' &&
          typeof entry.worktreeSession.worktreePath === 'string' &&
          typeof entry.worktreeSession.worktreeName === 'string'
        ) {
          worktreeSession = entry.worktreeSession
        }
      }

      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
        customTitle = entry.customTitle
      }

      if (
        !entry.isMeta &&
        !!entry.message?.role &&
        (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system')
      ) {
        transcriptMessageCount += 1
      }

      accumulateTranscriptContext(contextState, entry)

      const usage = entry.message?.usage
      const model = entry.message?.model
      if (!usage || typeof model !== 'string') return

      const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      const cacheReadInputTokens = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
      const cacheCreationInputTokens = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
      const webSearchRequests = typeof usage.server_tool_use?.web_search_requests === 'number'
        ? usage.server_tool_use.web_search_requests
        : 0

      // Fork-inherited lines and the repeated usage objects of a multi-block reply are the
      // same class of over-count; `claimUsageRecord` rejects both.
      if (!claimUsageRecord(entry, countedUsageKeys)) return

      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheReadInputTokens === 0 &&
        cacheCreationInputTokens === 0 &&
        webSearchRequests === 0
      ) {
        return
      }

      const canonical = getCanonicalName(model)
      if (!Object.prototype.hasOwnProperty.call(MODEL_COSTS, canonical)) {
        hasUnknownModelCost = true
      }

      const costUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: cacheCreationInputTokens,
        server_tool_use: { web_search_requests: webSearchRequests },
        speed: usage.speed,
      } as Parameters<typeof calculateUSDCost>[1]
      const costUSD = calculateUSDCost(model, costUsage)

      let modelUsage = models.get(model)
      if (!modelUsage) {
        modelRuntimeHints.set(model, { runtimeProviderId, runtimeModelId })
        if (models.size >= 64 || model.length > 512) throw new ApiError(413, 'Usage inspection exceeds its model budget', 'HISTORY_INSPECTION_LIMIT')
        modelUsage = {
          model,
          displayName: canonical,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          costDisplay: '$0.0000',
          contextWindow: 0,
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        }
        models.set(model, modelUsage)
      }

      modelUsage.inputTokens += inputTokens
      modelUsage.outputTokens += outputTokens
      modelUsage.cacheReadInputTokens += cacheReadInputTokens
      modelUsage.cacheCreationInputTokens += cacheCreationInputTokens
      modelUsage.webSearchRequests += webSearchRequests
      modelUsage.costUSD += costUSD
      modelUsage.costDisplay = this.formatCost(modelUsage.costUSD)

      totalCostUSD += costUSD
      totalInputTokens += inputTokens
      totalOutputTokens += outputTokens
      totalCacheReadInputTokens += cacheReadInputTokens
      totalCacheCreationInputTokens += cacheCreationInputTokens
      totalWebSearchRequests += webSearchRequests

      if (entry.timestamp) {
        const time = Date.parse(entry.timestamp)
        if (!Number.isNaN(time)) {
          firstUsageAt = firstUsageAt === null ? time : Math.min(firstUsageAt, time)
          lastUsageAt = lastUsageAt === null ? time : Math.max(lastUsageAt, time)
        }
      }
    })

    const workDir = latestWorkDir || latestCwd || this.desanitizePath(found.projectDir) || process.cwd()
    const launchInfo: SessionLaunchInfo = {
      filePath: found.filePath,
      projectDir: found.projectDir,
      workDir,
      repository,
      worktreeSession,
      transcriptMessageCount,
      customTitle,
      permissionMode,
      ...(runtimeProviderId !== undefined ? { runtimeProviderId } : {}),
      ...(runtimeModelId ? { runtimeModelId } : {}),
      ...(effortLevel ? { effortLevel } : {}),
    }

    for (const modelUsage of models.values()) {
      modelUsage.contextWindow = await this.getTranscriptContextWindow(
        sessionId,
        modelUsage.model,
        modelRuntimeHints.get(modelUsage.model),
      )
    }

    const usage = models.size === 0
      ? null
      : {
          source: 'transcript' as const,
          totalCostUSD,
          costDisplay: this.formatCost(totalCostUSD),
          hasUnknownModelCost,
          totalAPIDuration: 0,
          // Generation timings live only in the CLI process (and the resume snapshot it
          // writes to project config); a transcript has no per-response span to rebuild
          // them from, so callers must treat 0 as "unknown" rather than "instant".
          totalDecodeDuration: 0,
          totalTtftDuration: 0,
          totalDuration:
            firstUsageAt !== null && lastUsageAt !== null
              ? Math.max(0, Math.round((lastUsageAt - firstUsageAt) / 1000))
              : 0,
          totalLinesAdded: 0,
          totalLinesRemoved: 0,
          totalInputTokens,
          totalOutputTokens,
          totalCacheReadInputTokens,
          totalCacheCreationInputTokens,
          totalWebSearchRequests,
          models: Array.from(models.values()),
        }
    const latestContextUsage = resolveTranscriptContextUsage(contextState)
    const contextEstimate = latestContextUsage
      ? await this.buildTranscriptContextEstimate(
          sessionId,
          latestContextUsage,
          contextState.estimatedTokensFromMessages,
          contextState.estimatedTokensAfterUsage,
          contextState.transcriptHasMediaInput,
          launchInfo,
        )
      : null

    return {
      launchInfo,
      metadata,
      usage,
      contextEstimate,
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Browse one logical project's history independently of the recent list. */
  listProjectHistory(options: ProjectHistoryOptions): Promise<ProjectHistoryPage> {
    return this.projectHistory.list(options)
  }

  /** Load the newest few sessions for every logical project in one request. */
  listProjectPreviews(perProjectLimit?: number): Promise<ProjectSessionPreviews> {
    return this.projectHistory.listPreviews(perProjectLimit)
  }

  private projectHistoryRevision(): string {
    this.syncSharedMutationEpoch()
    const scope = this.getConfigDir()
    this.prepareSessionListCaches(scope)
    const indexed = this.getUsableIndexMode() === 'on'
    const status = indexed ? this.localIndexGateway.getPublicStatus() : null
    return JSON.stringify([scope, this.sessionListCacheGeneration,
      indexed && (status?.state === 'ready' || status?.state === 'building')
        ? status.lastUpdatedAt
        : 'files'])
  }

  private async loadProjectHistoryRows(): Promise<ProjectHistoryRow[]> {
    const scope = this.getConfigDir()
    let indexedRows: IndexedSessionRow[] | null = null
    if (this.getUsableIndexMode() === 'on') {
      const status = this.localIndexGateway.getPublicStatus()
      if (status.state === 'ready' || status.state === 'building') {
        try {
          indexedRows = []
          // No await between index pages: a coordinator projection cannot shift
          // the order while this synchronous metadata snapshot is collected.
          for (let offset = 0; ; offset += 500) {
            const page = this.localIndexGateway.listSessions({ limit: 500, offset })
            if (!this.indexStatusRemainsUsable()) throw new Error('Index unavailable')
            indexedRows.push(...page.sessions)
            if (offset + page.sessions.length >= page.total) break
            if (page.sessions.length === 0) break
          }
        } catch {
          this.markIndexReadFailure()
          indexedRows = null
        }
      }
    }
    if (indexedRows === null) {
      const indexMode = this.getUsableIndexMode()
      if (indexMode === 'on') {
        // Same rule as listSessions: never scan every JSONL just to fill history.
        return []
      }
      indexedRows = []
      // Files remain authoritative in off/shadow mode. Summaries are streamed
      // and shared with the existing list cache; messages never load.
      for (const file of await this.discoverSessionFiles(undefined, scope)) {
        try {
          const stat = await fs.stat(file.filePath)
          const summary = await this.getCachedSessionListSummary(file.filePath, file.projectDir, stat, scope)
          indexedRows.push({ ...summary, id: file.sessionId, projectPath: file.projectDir, transcriptPath: file.filePath })
        } catch { /* Ignore unreadable transcripts, like the normal list. */ }
      }
    }

    const roots = new Map<string, string | null>()
    const rows: ProjectHistoryRow[] = []
    for (const row of indexedRows) {
      // Thousands of sessions normally share a handful of workspaces. Resolve
      // each candidate once, preserving the same worktree/git boundary as list.
      const candidate = row.worktreeSession?.originalCwd || row.repository?.repoRoot || row.workDir || this.desanitizePath(row.projectPath)
      const key = JSON.stringify([candidate, Boolean(row.workDir)])
      let root = roots.get(key)
      if (!roots.has(key)) {
        root = await this.resolveProjectRootFromSessionMetadata({
          worktreeSession: row.worktreeSession, repository: row.repository,
          workDir: row.workDir, fallbackProjectDir: row.projectPath,
        })
        roots.set(key, root)
      }
      rows.push({ ...row, logicalProjectRoot: root || row.workDir || row.projectPath || 'unknown' })
    }
    return rows
  }

  getSessionSuggestionMetadata(sessionIds: string[]): Array<{ id: string; title: string; workDir: string | null; projectPath: string; modifiedAt: string }> {
    this.syncSharedMutationEpoch()
    if (this.getUsableIndexMode() !== 'on') return []
    try {
      const rows = this.localIndexGateway.getSessionSuggestionMetadata?.(sessionIds.slice(0, 100)) ?? []
      if (!this.indexStatusRemainsUsable()) return []
      return rows.map(({ id, title, workDir, projectPath, modifiedAt }) => ({ id, title, workDir, projectPath, modifiedAt }))
    } catch { this.markIndexReadFailure(); return [] }
  }

  /** Metadata-only reference lookup: no per-result transcript or workspace hydration. */
  async searchSessionMetadata(query: string, options: { limit?: number; offset?: number; signal?: AbortSignal; deadlineMs?: number } = {}): Promise<{ sessions: Array<{ id: string; title: string; workDir: string | null; projectPath: string; modifiedAt: string }>; total: number; truncated?: boolean }> {
    options.signal?.throwIfAborted()
    this.syncSharedMutationEpoch()
    const limit = Math.min(100, Math.max(1, options.limit ?? 30))
    const offset = Math.max(0, options.offset ?? 0)
    const epoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    if (this.getUsableIndexMode() === 'on') {
      try {
        const result = this.localIndexGateway.searchSessionMetadata?.(query, { limit, offset })
        if (result && epoch === getSharedSessionMutationState(this.localIndexGateway).epoch && this.indexStatusRemainsUsable()) {
          return { sessions: result.sessions.map(({ id, title, workDir, projectPath, modifiedAt }) => ({ id, title, workDir, projectPath, modifiedAt })), total: result.total }
        }
      } catch { this.markIndexReadFailure() }
    }
    // Scan the metadata projection once, rank before limiting, and reuse its
    // summary cache. Do not hydrate every workspace or repeatedly page lists.
    const scope = this.getConfigDir()
    this.prepareSessionListCaches(scope)
    const rows: Array<{ id: string; title: string; workDir: string | null; projectPath: string; modifiedAt: string }> = []
    let truncated = false
    for (const file of await this.discoverSessionFiles(undefined, scope)) {
      options.signal?.throwIfAborted()
      // The picker shares this process with every other request. Stop walking
      // transcripts once its budget is spent and return the rows already read.
      if (options.deadlineMs !== undefined && Date.now() > options.deadlineMs) { truncated = true; break }
      try {
        const summary = await this.getCachedSessionListSummary(file.filePath, file.projectDir, await fs.stat(file.filePath), scope)
        rows.push({ id: file.sessionId, title: summary.title, workDir: summary.workDir, projectPath: file.projectDir, modifiedAt: summary.modifiedAt })
      } catch { /* Match sidebar behavior for unreadable transcripts. */ }
    }
    const needle = query.trim().toLowerCase()
    const rank = (row: typeof rows[number]) => {
      if (!needle) return 0
      const names = [row.title.toLowerCase(), row.id.toLowerCase()]
      return names.includes(needle) ? 3 : names.some(value => value.startsWith(needle)) ? 2 : names.some(value => value.includes(needle)) ? 1 : 0
    }
    const matches = rows.filter(row => [row.title, row.id, row.workDir ?? '', row.projectPath].some(value => value.toLowerCase().includes(needle)))
    matches.sort((a, b) => rank(b) - rank(a) || Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) || a.id.localeCompare(b.id) || a.projectPath.localeCompare(b.projectPath))
    return { sessions: matches.slice(offset, offset + limit), total: matches.length, ...(truncated ? { truncated } : {}) }
  }

  /** List all sessions, optionally filtered by physical project path. */
  async listSessions(options?: {
    project?: string
    limit?: number
    offset?: number
  }): Promise<{ sessions: SessionListItem[]; total: number }> {
    this.syncSharedMutationEpoch()
    const routingMutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    const hasInvalidPagination = [options?.limit, options?.offset]
      .some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    if (hasInvalidPagination) return this.listSessionsFromFiles(options)

    const indexMode = this.getUsableIndexMode()
    if (indexMode === null) {
      return this.listSessionsFromFiles(options)
    }

    if (indexMode === 'shadow') {
      const fileResult = await this.listSessionsFromFiles(options)
      if (
        routingMutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch
      ) {
        return this.listSessionsFromFiles(options)
      }
      let status: LocalIndexStatus
      try {
        status = this.localIndexGateway.getPublicStatus()
      } catch {
        this.markIndexReadFailure()
        return fileResult
      }
      if (status.state !== 'ready') return fileResult
      const indexedResult = await this.tryListSessionsFromIndex(options, true)
      if (
        routingMutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch
      ) {
        return this.listSessionsFromFiles(options)
      }
      if (indexedResult) {
        this.recordShadowComparisonIfNeeded(
          this.compareSessionLists(fileResult, indexedResult),
        )
      }
      return fileResult
    }

    return await this.tryListSessionsFromIndex(options) ?? this.listSessionsFromFiles(options)
  }

  private async listSessionsFromFiles(options?: {
    project?: string
    limit?: number
    offset?: number
  }): Promise<{ sessions: SessionListItem[]; total: number }> {
    this.syncSharedMutationEpoch()
    const scope = this.getConfigDir()
    this.prepareSessionListCaches(scope)
    const cacheKey = this.sessionListCacheKey(options, scope)
    const cached = this.sessionListCache.get(cacheKey)
    if (cached) {
      this.touchSessionListCacheEntry(cacheKey, cached)
      return this.cloneSessionListResult(cached.result)
    }

    const cacheGeneration = this.sessionListCacheGeneration
    const sharedMutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    const requestKey = `${cacheGeneration}:${sharedMutationEpoch}:${cacheKey}`
    const inFlight = this.sessionListRequests.get(requestKey)
    if (inFlight) {
      return this.cloneSessionListResult(await inFlight)
    }

    const request = this.loadSessionList(
      options,
      cacheKey,
      cacheGeneration,
      sharedMutationEpoch,
      scope,
    )
    this.sessionListRequests.set(requestKey, request)
    try {
      return this.cloneSessionListResult(await request)
    } finally {
      if (this.sessionListRequests.get(requestKey) === request) {
        this.sessionListRequests.delete(requestKey)
      }
    }
  }

  private async tryListSessionsFromIndex(options?: {
    project?: string
    limit?: number
    offset?: number
  }, requireReady = false): Promise<{ sessions: SessionListItem[]; total: number } | null> {
    const indexedMutationEpoch = getSharedSessionMutationState(this.localIndexGateway).epoch
    try {
      const indexedPage = this.localIndexGateway.listSessions({
        ...(options?.project
          ? {
              project: this.sanitizePath(
                normalizeDriveRootPathForPlatform(options.project),
              ),
            }
          : {}),
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.offset !== undefined ? { offset: options.offset } : {}),
      })
      if (!this.indexStatusRemainsUsable()) {
        this.markIndexReadFailure()
        return null
      }

      const status = this.localIndexGateway.getPublicStatus()
      if (requireReady && status.state !== 'ready') return null
      if (indexedPage.sessions.length === 0) {
        // Building must not fall through to a full JSONL scan. The sidebar
        // already treats an empty building page as loading.
        return status.state === 'building'
          ? { sessions: [], total: indexedPage.total }
          : null
      }

      const sessions: SessionListItem[] = []
      const pathExists = this.createCachedPathExists()
      const projectsRoot = await fs.realpath(this.getProjectsDir())
      for (const row of indexedPage.sessions) {
        try {
          await this.validateIndexedTranscriptPath(
            row.transcriptPath,
            row.projectPath,
            row.id,
            projectsRoot,
          )
          sessions.push(await this.hydrateIndexedSession(row, pathExists))
        } catch {
          // Drop a single stale/unreadable row instead of scanning every JSONL.
        }
      }
      if (
        indexedMutationEpoch !== getSharedSessionMutationState(this.localIndexGateway).epoch
      ) {
        return null
      }
      if (sessions.length === 0) {
        return status.state === 'building'
          ? { sessions: [], total: indexedPage.total }
          : null
      }
      return { sessions, total: indexedPage.total }
    } catch {
      this.markIndexReadFailure()
      return null
    }
  }

  private async hydrateIndexedSession(
    row: IndexedSessionRow,
    pathExists = (targetPath: string | null) => this.pathExists(targetPath),
  ): Promise<SessionListItem> {
    const workDir = row.workDir
    const projectRoot = await this.resolveProjectRootFromSessionMetadata({
      worktreeSession: row.worktreeSession,
      repository: row.repository,
      workDir,
      fallbackProjectDir: row.projectPath,
    })
    const { workDirExists, workspaceState } = await this.resolveWorkspaceAvailability({
      workDir,
      projectRoot,
      worktreeSession: row.worktreeSession,
      repository: row.repository,
      pathExists,
    })
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt,
      messageCount: row.messageCount,
      projectPath: row.projectPath,
      projectRoot,
      workDir,
      workDirExists,
      workspaceState,
      permissionMode: row.permissionMode,
      ...(row.runtimeProviderId !== undefined
        ? { runtimeProviderId: row.runtimeProviderId }
        : {}),
      ...(row.runtimeModelId ? { runtimeModelId: row.runtimeModelId } : {}),
      ...(row.effortLevel ? { effortLevel: row.effortLevel } : {}),
    }
  }

  private compareSessionLists(
    fileResult: { sessions: SessionListItem[]; total: number },
    indexedResult: { sessions: SessionListItem[]; total: number },
  ): SessionListShadowComparison {
    const fieldHashes: SessionListShadowComparison['fieldHashes'] = []
    const fields: Array<keyof SessionListItem> = [
      'id',
      'title',
      'createdAt',
      'modifiedAt',
      'messageCount',
      'projectPath',
      'projectRoot',
      'workDir',
      'workDirExists',
      'workspaceState',
      'permissionMode',
      'runtimeProviderId',
      'runtimeModelId',
      'effortLevel',
    ]
    const hash = (value: unknown): string => createHash('sha256')
      .update(JSON.stringify(value) ?? 'undefined')
      .digest('hex')
    const rowCount = Math.max(fileResult.sessions.length, indexedResult.sessions.length)
    let differenceCount = fileResult.total === indexedResult.total ? 0 : 1
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      for (const field of fields) {
        const fileSession = fileResult.sessions[rowIndex]
        const indexedSession = indexedResult.sessions[rowIndex]
        const fileField = {
          present: fileSession !== undefined && Object.hasOwn(fileSession, field),
          value: fileSession?.[field],
        }
        const indexedField = {
          present: indexedSession !== undefined && Object.hasOwn(indexedSession, field),
          value: indexedSession?.[field],
        }
        if (JSON.stringify(fileField) === JSON.stringify(indexedField)) continue
        differenceCount += 1
        if (fieldHashes.length < 16) {
          fieldHashes.push({
            field: `session_${rowIndex}.${field}`,
            fileHash: hash(fileField),
            indexedHash: hash(indexedField),
          })
        }
      }
    }
    return {
      matched: differenceCount === 0,
      fileTotal: fileResult.total,
      indexedTotal: indexedResult.total,
      fileCount: fileResult.sessions.length,
      indexedCount: indexedResult.sessions.length,
      differenceCount,
      fieldHashes,
    }
  }

  private recordShadowComparisonIfNeeded(comparison: SessionListShadowComparison): void {
    const signature = createHash('sha256')
      .update(JSON.stringify(comparison))
      .digest('hex')
    if (signature === this.lastShadowComparisonSignature) return
    const now = this.now()
    if (now - this.lastShadowComparisonRecordedAt < this.shadowComparisonMinIntervalMs) return
    this.lastShadowComparisonSignature = signature
    this.lastShadowComparisonRecordedAt = now
    this.recordShadowComparison(comparison)
  }

  private async loadSessionList(
    options: {
      project?: string
      limit?: number
      offset?: number
    } | undefined,
    cacheKey: string,
    cacheGeneration: number,
    sharedMutationEpoch: number,
    scope: string,
  ): Promise<{ sessions: SessionListItem[]; total: number }> {
    const sessionFiles = await this.discoverSessionFiles(options?.project, scope)
    if (!options?.project && this.activeSessionListCacheScope === scope) {
      const discoveredPaths = new Set(sessionFiles.map(file => file.filePath))
      for (const filePath of this.sessionListSummaryCache.keys()) {
        if (!discoveredPaths.has(filePath)) this.sessionListSummaryCache.delete(filePath)
      }
    }
    const filesWithStats = (await Promise.all(sessionFiles.map(async (sessionFile) => {
      try {
        return {
          ...sessionFile,
          stat: await fs.stat(sessionFile.filePath),
        }
      } catch {
        return null
      }
    }))).filter((item): item is NonNullable<typeof item> => item !== null)

    const summarizedFiles: Array<{
      filePath: string
      projectDir: string
      sessionId: string
      stat: Stats
      summary: SessionListSummary
    }> = []
    for (const item of filesWithStats) {
      try {
        summarizedFiles.push({
          ...item,
          summary: await this.getCachedSessionListSummary(
            item.filePath,
            item.projectDir,
            item.stat,
            scope,
          ),
        })
      } catch {
        // Skip unreadable files
      }
    }

    summarizedFiles.sort((a, b) => {
      const modifiedAtDifference =
        Date.parse(b.summary.modifiedAt) - Date.parse(a.summary.modifiedAt)
      if (modifiedAtDifference !== 0) return modifiedAtDifference
      const sessionIdDifference = a.sessionId.localeCompare(b.sessionId)
      return sessionIdDifference || a.filePath.localeCompare(b.filePath)
    })

    const total = summarizedFiles.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 50
    const paginatedFiles = summarizedFiles.slice(offset, offset + limit)

    // Build session list items with metadata from file stats & a streaming
    // transcript summary. Keep this sequential so large JSONL files are not
    // loaded into memory concurrently by the sidebar's frequent refresh.
    const items: SessionListItem[] = []
    const pathExists = this.createCachedPathExists()
    for (const { projectDir, sessionId, summary } of paginatedFiles) {
      try {
        const workDir = summary.workDir
        const projectRoot = await this.resolveProjectRootFromSessionMetadata({
          worktreeSession: summary.worktreeSession,
          repository: summary.repository,
          workDir,
          fallbackProjectDir: projectDir,
        })
        const { workDirExists, workspaceState } = await this.resolveWorkspaceAvailability({
          workDir,
          projectRoot,
          worktreeSession: summary.worktreeSession,
          repository: summary.repository,
          pathExists,
        })

        items.push({
          id: sessionId,
          title: summary.title,
          createdAt: summary.createdAt,
          modifiedAt: summary.modifiedAt,
          messageCount: summary.messageCount,
          projectPath: projectDir,
          projectRoot,
          workDir,
          workDirExists,
          workspaceState,
          permissionMode: summary.permissionMode,
          ...(summary.runtimeProviderId !== undefined
            ? { runtimeProviderId: summary.runtimeProviderId }
            : {}),
          ...(summary.runtimeModelId ? { runtimeModelId: summary.runtimeModelId } : {}),
          ...(summary.effortLevel ? { effortLevel: summary.effortLevel } : {}),
        })
      } catch {
        // Skip unreadable files
      }
    }

    const result = { sessions: items, total }
    if (
      cacheGeneration === this.sessionListCacheGeneration &&
      sharedMutationEpoch === getSharedSessionMutationState(this.localIndexGateway).epoch &&
      this.activeSessionListCacheScope === scope
    ) {
      this.sessionListCache.set(cacheKey, {
        expiresAt: this.now() + this.sessionListCacheTtlMs,
        result: this.cloneSessionListResult(result),
      })
      this.enforceSessionListCacheCapacity()
    }
    return result
  }

  /** Resolve one session's list metadata without materializing its messages. */
  async getSessionSummary(sessionId: string): Promise<SessionListItem | null> {
    this.syncSharedMutationEpoch()
    const scope = this.getConfigDir()
    this.prepareSessionListCaches(scope)
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    try {
      const { filePath, projectDir } = found
      const stat = await fs.stat(filePath)
      const summary = await this.getCachedSessionListSummary(filePath, projectDir, stat, scope)
      return await this.hydrateIndexedSession({
        ...summary,
        id: sessionId,
        projectPath: projectDir,
        transcriptPath: filePath,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * Get full session detail including all messages.
   */
  async getSession(
    sessionId: string,
    options?: SessionMessagesOptions,
  ): Promise<SessionDetail | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const { filePath, projectDir } = found
    const stat = await fs.stat(filePath)
    const entries = await this.readJsonlFile(filePath)

    const rootMessages = this.entriesToMessages(entries)
    const messages = options?.includeSubagents === false
      ? rootMessages
      : (await this.appendSubagentToolMessages(projectDir, sessionId, rootMessages)).messages
    const title = this.extractTitle(entries)
    const workDir = this.resolveWorkDirFromEntries(entries, projectDir)
    const permissionMode = this.resolvePermissionModeFromEntries(entries)
    const projectRoot = await this.resolveProjectRootFromEntries(entries, workDir, projectDir)
    const worktreeSession = this.resolveWorktreeSessionFromEntries(entries)
    const repository = this.resolveRepositoryFromEntries(entries)
    const { workDirExists, workspaceState } = await this.resolveWorkspaceAvailability({
      workDir,
      projectRoot,
      worktreeSession,
      repository,
    })

    let createdAt = stat.birthtime.toISOString()
    for (const e of entries) {
      if (e.timestamp) {
        createdAt = e.timestamp
        break
      }
    }

    return {
      id: sessionId,
      title,
      createdAt,
      modifiedAt: this.resolveTranscriptModifiedAtFromEntries(entries) ?? stat.mtime.toISOString(),
      messageCount: messages.length,
      projectPath: projectDir,
      projectRoot,
      workDir,
      workDirExists,
      workspaceState,
      permissionMode,
      messages,
    }
  }

  /**
   * Read HTTP history and notifications together without merging child payloads.
   */
  async getSessionHistoryRecovery(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<SessionHistoryRecovery> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      const key = this.memorySessionKey(sessionId)
      if (this.memoryLaunchInfo.has(key) || this.knownSessionKeys.has(key)) {
        return { sourceVersion: 'memory', status: 'ready', messages: [], taskNotifications: [], tokenUsage: null, omittedRecords: 0 }
      }
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    const stat = await fs.stat(found.filePath, { bigint: true })
    const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
    const cacheKey = this.memorySessionKey(sessionId)
    const cached = this.historyRecoveryCache.get(cacheKey)
    if (cached?.sourceVersion === version) {
      this.historyRecoveryCache.delete(cacheKey)
      this.historyRecoveryCache.set(cacheKey, cached)
      return cached
    }
    const recovery = await recoverBoundedSessionHistory({
      filePath: found.filePath,
      signal: options.signal,
      toMessage: (entry, owner) => {
        const raw = entry as RawEntry
        const goal = this.goalLocalCommandEntryToMessage(raw)
        if (goal) return goal
        if (!this.isVisibleTranscriptMessageEntry(raw)) return null
        return this.entryToMessage(raw, owner)
      },
      notifications: entry => this.taskNotificationsFromEntries([entry as RawEntry]),
    })
    this.historyRecoveryCache.delete(cacheKey)
    this.historyRecoveryCache.set(cacheKey, recovery)
    while (this.historyRecoveryCache.size > 2) this.historyRecoveryCache.delete(this.historyRecoveryCache.keys().next().value!)
    return recovery
  }

  private async projectHistoryPageEntries(filePath: string, result: Awaited<ReturnType<typeof readBoundedHistoryPage>>, signal?: AbortSignal, includeUnownedSidechains = false): Promise<{ entries: RawEntry[]; contextScanBytes: number }> {
    const context = await readHistoryContexts({
      filePath,
      sourceVersion: result.page.sourceVersion,
      offsets: result.entries.map(item => item.byteStart),
      signal,
      includeUnownedSidechains,
      classify: raw => {
        const entry = raw as RawEntry
        const user = entry.message?.role === 'user' && !entry.isMeta
        return {
          notification: user && this.isTaskNotificationContent(entry.message?.content),
          reset: user && !this.isToolResultContent(entry.message?.content),
          agentToolId: this.extractAgentToolUseId(entry),
        }
      },
    })
    const visibleEntries = result.entries.flatMap(item => {
      const state = context.contexts.get(item.byteStart)!
      if (state.suppressed && !this.isGoalLocalCommandEntry(item.entry as RawEntry)) return []
      return [{ ...item.entry, ...(state.owner ? { parent_tool_use_id: state.owner } : {}) } as RawEntry]
    })
    return { entries: visibleEntries, contextScanBytes: context.scannedBytes }
  }

  async getSessionHistoryPage(sessionId: string, options: { cursor?: string; limit?: number; signal?: AbortSignal; full?: boolean; projectContext?: boolean } = {}): Promise<{
    messages: MessageEntry[]
    taskNotifications: SessionTaskNotification[]
    page: HistoryPageInfo
  }> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      const key = this.memorySessionKey(sessionId)
      if (this.memoryLaunchInfo.has(key) || this.knownSessionKeys.has(key)) {
        return { messages: [], taskNotifications: [], page: { nextCursor: null, hasMore: false, historyComplete: true, sourceVersion: 'memory', scannedBytes: 0, omittedOversizedEntries: 0 } }
      }
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }
    const result = await readBoundedHistoryPage(found.filePath, options)
    // A referenced-session read only needs the records on this page. Building
    // the ownership index scans the transcript from the start, which is what
    // stalls the shared server while a model pages backward.
    const projection = options.projectContext === false
      ? { entries: result.entries.map(item => item.entry as RawEntry), contextScanBytes: 0 }
      : await this.projectHistoryPageEntries(found.filePath, result, options.signal)
    const entries = result.entries.map(item => item.entry as RawEntry)
    const response = { messages: this.entriesToMessages(projection.entries), taskNotifications: this.taskNotificationsFromEntries(entries), page: { ...result.page, contextScanBytes: projection.contextScanBytes } }
    // The full-history path is already bounded by the reader's own byte budget,
    // so only the single-record page path needs the "one oversized record"
    // envelope check.
    if (!options.full && Buffer.byteLength(JSON.stringify(response)) > 2 * HISTORY_SEMANTIC_RECORD_BYTES + HISTORY_PAGE_BYTES) {
      throw new ApiError(413, 'History page exceeded its response budget', 'HISTORY_PAGE_TOO_LARGE')
    }
    return response
  }

  async getSessionHistory(sessionId: string): Promise<{
    messages: MessageEntry[]
    taskNotifications: SessionTaskNotification[]
  }> {
    const key = this.memorySessionKey(sessionId)
    const existing = this.sessionHistoryRequests.get(key)
    if (existing) return existing
    const request = (async () => {
      const found = await this.findSessionFile(sessionId)
      if (!found) {
        if (this.memoryLaunchInfo.has(key) || this.knownSessionKeys.has(key)) {
          return { messages: [], taskNotifications: [] }
        }
        throw ApiError.notFound(`Session not found: ${sessionId}`)
      }
      const entries = await this.readJsonlFile(found.filePath)
      return {
        messages: this.entriesToMessages(entries),
        taskNotifications: this.taskNotificationsFromEntries(entries),
      }
    })()
    this.sessionHistoryRequests.set(key, request)
    try {
      return await request
    } finally {
      // Coalesce overlapping requests only; retaining histories as a cache
      // would pin hundreds of MB per session after callers close their views.
      this.sessionHistoryRequests.delete(key)
    }
  }

  async getSessionMessages(
    sessionId: string,
    options?: SessionMessagesOptions,
  ): Promise<MessageEntry[]> {
    return (await this.getSessionMessagesWithEvidence(sessionId, options)).messages
  }

  async getSessionMessagesWithEvidence(
    sessionId: string,
    options?: SessionMessagesOptions,
  ): Promise<SessionMessagesWithEvidence> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      // Retention-zero sessions intentionally have no transcript. The desktop
      // still asks for turn checkpoints after each live reply; lack of saved
      // evidence is not a missing session, nor proof of an empty history.
      if (this.memoryLaunchInfo.has(this.memorySessionKey(sessionId)) ||
        this.knownSessionKeys.has(this.memorySessionKey(sessionId))) {
        return { messages: [], transcriptEvidenceComplete: false }
      }
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const rootTranscript = await this.readJsonlFileWithDiagnostics(found.filePath)
    const rootMessages = this.entriesToMessages(rootTranscript.entries)
    const rootEvidenceComplete = rootTranscript.exists && rootTranscript.parseComplete
    if (options?.includeSubagents === false) {
      return { messages: rootMessages, transcriptEvidenceComplete: rootEvidenceComplete }
    }
    const subagentResult = await this.appendSubagentToolMessages(
      found.projectDir,
      sessionId,
      rootMessages,
    )
    return {
      messages: subagentResult.messages,
      transcriptEvidenceComplete: rootEvidenceComplete &&
        subagentResult.subagentEvidenceComplete,
    }
  }

  async getSubagentTranscriptMessages(
    sessionId: string,
    agentId: string,
  ): Promise<MessageEntry[]> {
    return (await this.getSubagentTranscript(sessionId, agentId)).messages
  }

  /** Read only the addressed Agent call and result. Ordinary transcript bodies
   * are parsed one bounded record at a time and never retained by card lookup. */
  async getSubagentRunLookup(sessionId: string, toolRef: string, agentId?: string): Promise<SubagentTranscript> {
    const found = await this.findSessionFile(sessionId)
    if (!found) throw ApiError.notFound(`Session not found: ${sessionId}`)
    const filePath = agentId ? this.subagentTranscriptPath(found.projectDir, sessionId, agentId) : found.filePath
    const leaf = toolRef.slice(toolRef.lastIndexOf('/') + 1)
    const ids = new Set([toolRef, leaf])
    const stat = await fs.stat(filePath, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) return { messages: [], taskNotifications: [], historyComplete: true }
    const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
    const key = JSON.stringify([filePath, toolRef])
    const cached = this.subagentLookupCache.get(key)
    if (cached?.version === version) return cached.transcript
    return withHistoryReadBudget(undefined, async () => {
      const entries: RawEntry[] = []
      const taskNotifications: SessionTaskNotification[] = []
      let bytes = 0
      let incomplete = false
      let suppressTaskNotificationResponse = false
      const scan = await streamBoundedHistory(filePath, raw => {
        const entry = raw as RawEntry
        const message = raw.message as { role?: string; content?: unknown } | undefined
        if (!entry.isMeta && message?.role === 'user') {
          if (this.isTaskNotificationContent(message.content)) suppressTaskNotificationResponse = true
          else if (!this.isToolResultContent(message.content)) suppressTaskNotificationResponse = false
        }
        const content = Array.isArray(message?.content) ? message.content.filter((block: any) =>
          block?.type === 'tool_use' ? ids.has(block.id) : block?.type === 'tool_result' && ids.has(block.tool_use_id)) : []
        const notices = this.taskNotificationsFromEntries([entry]).filter(notice => ids.has(notice.toolUseId))
        const selected = content.length && !suppressTaskNotificationResponse
          ? displayPreview({ ...entry, message: { ...message, content } }) : undefined
        if (selected?.bodyTruncated) incomplete = true
        const selectedBytes = (selected ? Buffer.byteLength(JSON.stringify(selected)) : 0) +
          (notices.length ? Buffer.byteLength(JSON.stringify(notices)) : 0)
        if (bytes + selectedBytes > 2 * 1024 * 1024 || entries.length + taskNotifications.length + (selected ? 1 : 0) + notices.length > 2048) {
          incomplete = true
          return
        }
        bytes += selectedBytes
        if (selected) entries.push(selected as RawEntry)
        taskNotifications.push(...notices)
      }, undefined, { maxRecordBytes: HISTORY_SEMANTIC_RECORD_BYTES })
      // A skipped record may be unrelated to this Agent. Preserve the evidence
      // we did read without claiming that absence proves a missing run.
      const transcript = { messages: this.entriesToMessages(entries), taskNotifications, historyComplete: !incomplete && scan.omittedRecords === 0 }
      this.subagentLookupCache.delete(key)
      this.subagentLookupCache.set(key, { version, transcript })
      while (this.subagentLookupCache.size > 4) this.subagentLookupCache.delete(this.subagentLookupCache.keys().next().value!)
      return transcript
    }, 'metadata')
  }

  async getSubagentTranscript(
    sessionId: string,
    agentId: string,
    options: { bounded?: boolean; toolUseId?: string } = {},
  ): Promise<SubagentTranscript> {
    if (options.toolUseId) return this.getSubagentRunLookup(sessionId, options.toolUseId, agentId)
    const found = await this.findSessionFile(sessionId)
    if (!found) throw ApiError.notFound(`Session not found: ${sessionId}`)
    const filePath = this.subagentTranscriptPath(found.projectDir, sessionId, agentId)
    if (options.bounded) {
      try {
        // A byte-bounded small transcript can preserve the full Activity view,
        // including more than 1000 tiny records. Large files use the tail page.
        if ((await fs.stat(filePath)).size <= 1536 * 1024) {
          return await withHistoryReadBudget(undefined, async () => {
            const entries: RawEntry[] = []
            let retainedBytes = 0
            const scan = await streamBoundedHistory(filePath, entry => {
              retainedBytes += Buffer.byteLength(JSON.stringify(entry))
              if (retainedBytes > 2 * 1024 * 1024) throw new ApiError(413, 'Agent transcript changed beyond its viewing budget', 'SUBAGENT_RECORD_LIMIT')
              if (entries.length >= 10_000) throw new ApiError(413, 'Agent transcript exceeds its record budget', 'SUBAGENT_RECORD_LIMIT')
              entries.push(entry as RawEntry)
            }, undefined, { maxRecordBytes: HISTORY_SEMANTIC_RECORD_BYTES })
            return { messages: this.entriesToMessages(entries), taskNotifications: this.taskNotificationsFromEntries(entries), historyComplete: scan.omittedRecords === 0 }
          })
        }
        const result = await readBoundedHistoryPage(filePath)
        const projection = await this.projectHistoryPageEntries(filePath, result, undefined, true)
        const entries = result.entries.map(item => item.entry as RawEntry)
        return {
          messages: this.entriesToMessages(projection.entries),
          taskNotifications: this.taskNotificationsFromEntries(entries),
          historyComplete: result.page.historyComplete,
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { messages: [], taskNotifications: [], historyComplete: true }
        throw error
      }
    }
    const entries = await this.readJsonlFile(filePath)
    return { messages: this.entriesToMessages(entries), taskNotifications: this.taskNotificationsFromEntries(entries) }
  }

  /**
   * Resolve which subagent transcript belongs to an Agent tool call.
   *
   * The sidecar metadata is written before the agent's query loop starts, so
   * this resolves while the run is still in flight. The parent transcript's
   * `tool_result` — the other way to recover an agent id — only lands once the
   * agent has finished, which left live runs pointing at no transcript at all.
   * `expectedOwnerAgentId` is the physical parent transcript id; null denotes
   * a root-owned tool call.
   */
  private async readSubagentMetadata(filePath: string): Promise<Record<string, unknown>> {
    const handle = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024 + 1)
      let length = 0
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > 64 * 1024) throw new ApiError(413, 'Agent metadata exceeds its viewing budget', 'SUBAGENT_METADATA_LIMIT')
      return JSON.parse(buffer.subarray(0, length).toString('utf8')) as Record<string, unknown>
    } finally { await handle.close() }
  }

  async findSubagentAgentIdByToolUseId(
    sessionId: string,
    toolUseId: string,
    expectedOwnerAgentId: string | null,
  ): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const subagentsDir = path.join(
      this.getProjectsDir(),
      found.projectDir,
      sessionId,
      'subagents',
    )
    const files = await fs.readdir(subagentsDir).catch(() => [])
    if (files.length > 4096) throw new ApiError(413, 'Agent directory exceeds its viewing budget', 'SUBAGENT_METADATA_LIMIT')
    const candidates: Array<{ agentId: string; ownerAgentId?: string }> = []
    let metadataComplete = true

    for (const metadataFile of files.filter((file) => file.endsWith('.meta.json'))) {
      try {
        const metadata = await this.readSubagentMetadata(path.join(subagentsDir, metadataFile))
        if (metadata.toolUseId !== toolUseId) continue
        const ownerAgentId = typeof metadata.ownerAgentId === 'string' && metadata.ownerAgentId
          ? metadata.ownerAgentId
          : undefined
        candidates.push({
          agentId: metadataFile.replace(/^agent-/, '').replace(/\.meta\.json$/, ''),
          ...(ownerAgentId ? { ownerAgentId } : {}),
        })
      } catch (error) {
        if (error instanceof ApiError) throw error
        // A half-written sidecar must not hide the other candidates.
        metadataComplete = false
      }
    }

    const exact = candidates.filter(candidate => expectedOwnerAgentId === null
      ? candidate.ownerAgentId === undefined
      : candidate.ownerAgentId === expectedOwnerAgentId)
    if (exact.length === 1) return exact[0]!.agentId
    if (exact.length > 1) return null

    // Metadata written before ownerAgentId existed can still resolve a nested
    // call, but only when the raw leaf identifies one sidecar in the complete
    // session. Picking the first of several legacy candidates recreates the
    // cross-parent collision this owner join is meant to prevent.
    if (
      expectedOwnerAgentId !== null &&
      metadataComplete &&
      candidates.length === 1 &&
      candidates[0]!.ownerAgentId === undefined
    ) {
      return candidates[0]!.agentId
    }

    return null
  }

  async getSubagentTranscriptFragmentsByAgentType(
    sessionId: string,
    agentType: string,
    options: { bounded?: boolean; toolUseId?: string } = {},
  ): Promise<SubagentTranscriptFragment[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const subagentsDir = path.join(
      this.getProjectsDir(),
      found.projectDir,
      sessionId,
      'subagents',
    )
    const files = await fs.readdir(subagentsDir).catch(() => [])
    if (files.length > 4096) throw new ApiError(413, 'Agent directory exceeds its viewing budget', 'SUBAGENT_METADATA_LIMIT')
    const fragments: SubagentTranscriptFragment[] = []

    for (const metadataFile of files.filter((file) => file.endsWith('.meta.json'))) {
      try {
        const metadata = await this.readSubagentMetadata(path.join(subagentsDir, metadataFile))
        if (metadata.agentType !== agentType) continue

        const transcriptFile = metadataFile.replace(/\.meta\.json$/, '.jsonl')
        const transcriptPath = path.join(subagentsDir, transcriptFile)
        const [transcript, stat] = await Promise.all([
          this.getSubagentTranscript(sessionId, transcriptFile.replace(/^agent-/, '').replace(/\.jsonl$/, ''), options),
          fs.stat(transcriptPath),
        ])
        fragments.push({
          agentId: transcriptFile.replace(/^agent-/, '').replace(/\.jsonl$/, ''),
          ...transcript,
          modifiedAt: stat.mtimeMs,
        })
        if (options.bounded && (fragments.length > 16 || Buffer.byteLength(JSON.stringify(fragments)) > 4 * 1024 * 1024)) throw new ApiError(413, 'Agent fragments exceed their viewing budget', 'SUBAGENT_FRAGMENTS_LIMIT')
      } catch (error) {
        if (error instanceof ApiError) throw error
        // A partially persisted fragment must not hide the other resumable runs.
      }
    }

    return fragments.sort((left, right) => (
      left.modifiedAt - right.modifiedAt || left.agentId.localeCompare(right.agentId)
    ))
  }

  async getSessionMessagesSignature(sessionId: string): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    // This is an invalidation token, not a digest of message content. Trace
    // polling must not parse hundreds of MB merely to decide whether to reload.
    // Include every child transcript so in-flight agents (before their result
    // links are persisted) also invalidate; metadata writes may also invalidate.
    const hash = createHash('sha256')
    const addFile = async (filePath: string): Promise<void> => {
      try {
        const stat = await fs.stat(filePath, { bigint: true })
        hash.update(JSON.stringify([
          filePath, String(stat.dev), String(stat.ino), String(stat.size),
          String(stat.mtimeNs), String(stat.ctimeNs),
        ]))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        hash.update(JSON.stringify([filePath, 'missing']))
      }
    }
    await addFile(found.filePath)
    const subagentsDir = path.join(path.dirname(found.filePath), sessionId, 'subagents')
    let children: string[]
    try {
      children = await fs.readdir(subagentsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      children = []
    }
    // Sequential stats bound concurrent I/O even for sessions with many agents.
    for (const name of children.filter(name => /^agent-.*\.jsonl$/.test(name)).sort()) {
      await addFile(path.join(subagentsDir, name))
    }
    return hash.digest('hex')
  }

  /**
   * Create a new session file for the given working directory.
   */
  async createSession(
    workDir?: string,
    repositoryOptions?: CreateSessionRepositoryOptions,
    permissionMode?: string,
  ): Promise<{ sessionId: string; workDir: string }> {
    // Default to user home directory when no workDir specified
    const persist = this.shouldPersistSession()
    const resolvedWorkDir = workDir || os.homedir()
    const sessionId = crypto.randomUUID()

    // Resolve to absolute path. NOTE: path.resolve() uses process.cwd() to
    // expand relative paths — in bundled sidecar mode the server's cwd is
    // typically '/'. Callers (IM adapters) already send absolute realPath,
    // but we log here so cwd regressions are caught early.
    const preparedWorkspace = await resolveSessionWorkspaceLaunch(
      resolvedWorkDir,
      repositoryOptions,
      sessionId,
    )
    const absWorkDir = preparedWorkspace.workDir
    registerFilesystemAccessRoot(absWorkDir)
    console.log(
      `[SessionService] createSession: requested workDir=${JSON.stringify(
        workDir,
      )}, resolved=${absWorkDir}, repository=${JSON.stringify(
        preparedWorkspace.repository ?? null,
      )} (process.cwd()=${process.cwd()})`,
    )

    const sanitized = this.sanitizePath(absWorkDir)
    const dirPath = path.join(this.getProjectsDir(), sanitized)

    // Ensure the project directory exists
    if (persist && this.shouldPersistSession()) await fs.mkdir(dirPath, { recursive: true })

    const filePath = path.join(dirPath, `${sessionId}.jsonl`)
    const now = new Date().toISOString()

    // Write an initial file-history-snapshot entry (matches CLI behavior)
    const initialEntry = {
      type: 'file-history-snapshot',
      messageId: crypto.randomUUID(),
      snapshot: {
        messageId: crypto.randomUUID(),
        trackedFileBackups: {},
        timestamp: now,
      },
      isSnapshotUpdate: false,
    }

    // Store actual workDir for later retrieval
    const metaEntry = {
      type: 'session-meta',
      isMeta: true,
      workDir: absWorkDir,
      repository: preparedWorkspace.repository,
      ...(permissionMode && VALID_SESSION_PERMISSION_MODES.has(permissionMode)
        ? { permissionMode }
        : {}),
      timestamp: now,
    }

    if (!persist || !this.shouldPersistSession()) this.memoryLaunchInfo.set(this.memorySessionKey(sessionId), {
      filePath, projectDir: sanitized, workDir: absWorkDir,
      repository: preparedWorkspace.repository, transcriptMessageCount: 0,
      customTitle: null,
      ...(permissionMode && VALID_SESSION_PERMISSION_MODES.has(permissionMode)
        ? { permissionMode } : {}),
    })
    if (persist && this.shouldPersistSession()) {
      await fs.writeFile(filePath, JSON.stringify(initialEntry) + '\n' + JSON.stringify(metaEntry) + '\n', 'utf-8')
    }
    this.knownSessionKeys.add(this.memorySessionKey(sessionId))
    this.invalidateSessionListCache()

    return { sessionId, workDir: absWorkDir }
  }

  /**
   * Delete a session's JSONL file.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found && !this.memoryLaunchInfo.has(this.memorySessionKey(sessionId)) &&
      !this.knownSessionKeys.has(this.memorySessionKey(sessionId))) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    if (found) await fs.unlink(found.filePath)
    this.knownSessionKeys.delete(this.memorySessionKey(sessionId))
    this.memoryLaunchInfo.delete(this.memorySessionKey(sessionId))
    this.privateTitles.delete(this.memorySessionKey(sessionId))
    if (found) this.sessionListSummaryCache.delete(found.filePath)
    this.invalidateSessionListCache()
  }

  async deleteSessions(sessionIds: string[]): Promise<DeleteSessionsResult> {
    const successes: string[] = []
    const failures: DeleteSessionFailure[] = []

    const results = await Promise.all(sessionIds.map(async (sessionId) => {
      try {
        await this.deleteSession(sessionId)
        return { type: 'success' as const, sessionId }
      } catch (error) {
        return {
          type: 'failure' as const,
          sessionId,
          message: error instanceof Error ? error.message : 'Unknown delete failure',
          code: error instanceof ApiError ? error.code : undefined,
        }
      }
    }))

    for (const result of results) {
      if (result.type === 'success') {
        successes.push(result.sessionId)
      } else {
        failures.push({
          sessionId: result.sessionId,
          message: result.message,
          code: result.code,
        })
      }
    }

    return { successes, failures }
  }

  /**
   * Rename a session by appending a custom-title entry to its JSONL file.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    if (!title || typeof title !== 'string') {
      throw ApiError.badRequest('title is required')
    }

    const persist = this.shouldPersistSession()
    const info = await this.getSessionLaunchInfo(sessionId)
    if (!info) throw ApiError.notFound(`Session not found: ${sessionId}`)
    if (!persist || !this.shouldPersistSession() || this.memoryLaunchInfo.has(this.memorySessionKey(sessionId))) {
      this.memoryLaunchInfo.set(this.memorySessionKey(sessionId), { ...info, customTitle: title })
    }
    if (!persist || !this.shouldPersistSession()) {
      this.rememberPrivateTitle(sessionId, title)
      return
    }
    const found = await this.findSessionFile(sessionId)
    if (!found || !this.canPersistTitle(sessionId, title)) return

    const entry = {
      type: 'custom-title',
      customTitle: title,
      timestamp: new Date().toISOString(),
    }

    await this.appendJsonlEntry(found.filePath, entry)
    this.syncIndexedSessionTitle(sessionId, title)
    this.invalidateSessionListCache()
  }

  /**
   * Append an AI-generated title entry to a session's JSONL file.
   */
  async appendAiTitle(sessionId: string, title: string, persist = this.shouldPersistSession()): Promise<void> {
    if (!persist || !this.shouldPersistSession()) {
      this.rememberPrivateTitle(sessionId, title)
      return
    }
    const found = await this.findSessionFile(sessionId)
    if (!found || !this.canPersistTitle(sessionId, title)) return

    await this.appendJsonlEntry(found.filePath, {
      type: 'ai-title',
      aiTitle: title,
      timestamp: new Date().toISOString(),
    })
    this.syncIndexedSessionTitle(sessionId, title)
    this.invalidateSessionListCache()
  }

  async getCustomTitle(sessionId: string): Promise<string | null> {
    const memory = this.memoryLaunchInfo.get(this.memorySessionKey(sessionId))
    if (memory?.customTitle) return memory.customTitle
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    return (await this.getMetadataProjection(found.filePath, found.projectDir)).customTitle
  }

  /**
   * Get the actual working directory for a session.
   * First checks for stored session-meta entry, then falls back to desanitizePath.
   */
  async getSessionWorkDir(sessionId: string): Promise<string | null> {
    const memory = this.memoryLaunchInfo.get(this.memorySessionKey(sessionId))
    if (memory) return memory.workDir
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const projection = await this.getMetadataProjection(found.filePath, found.projectDir)
    if (!projection.complete) throw new ApiError(413, 'Session metadata contains oversized records', 'SESSION_METADATA_INCOMPLETE')
    return projection.launchInfo.workDir
  }

  async getSessionMessageCwd(
    sessionId: string,
    messageId: string,
  ): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    const entry = entries.find((candidate) => candidate.uuid === messageId)
    return typeof entry?.cwd === 'string' && entry.cwd.trim() ? entry.cwd : null
  }

  /**
   * Inspect how a session should be launched.
   * Placeholder desktop-created sessions have zero transcript messages.
   */
  async getSessionLaunchInfo(sessionId: string): Promise<SessionLaunchInfo | null> {
    const memory = this.memoryLaunchInfo.get(this.memorySessionKey(sessionId))
    const found = await this.findSessionFile(sessionId)
    if (!found) return memory ? { ...memory, transcriptMessageCount: 0 } : null

    const projection = await this.getMetadataProjection(found.filePath, found.projectDir)
    if (!projection.complete) throw new ApiError(413, 'Session metadata contains oversized records', 'SESSION_METADATA_INCOMPLETE')
    const projected = projection.launchInfo
    return { ...projected, ...memory, transcriptMessageCount: projected.transcriptMessageCount }
  }

  async deleteSessionFile(sessionId: string): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return
    await fs.unlink(found.filePath)
    this.invalidateSessionListCache()
  }

  async clearSessionTranscript(
    sessionId: string,
    fallbackWorkDir?: string,
    preservedPermissionMode?: string,
    preservedCustomTitle?: string | null,
  ): Promise<void> {
    const persist = this.shouldPersistSession()
    const nextEpoch = (this.taskNotificationMutationEpochs.get(sessionId) ?? 0) + 1
    this.taskNotificationMutationEpochs.set(sessionId, nextEpoch)
    this.clearingTaskNotificationSessions.add(sessionId)
    const pendingWrites = [...(this.pendingTaskNotificationWrites.get(sessionId) ?? [])]
    for (const pending of pendingWrites) pending.controller.abort()

    try {
      await Promise.allSettled(pendingWrites.map((pending) => pending.promise))

      if (!persist || !this.shouldPersistSession()) {
        const storedInfo = await this.getSessionLaunchInfo(sessionId)
        const workDir = fallbackWorkDir && normalizeDriveRootPathForPlatform(fallbackWorkDir)
        const projectDir = workDir && this.sanitizePath(workDir)
        const info = storedInfo ?? (workDir && projectDir ? {
          filePath: path.join(this.getProjectsDir(), projectDir, `${sessionId}.jsonl`),
          projectDir, workDir, transcriptMessageCount: 0, customTitle: null,
        } : null)
        if (info) {
          this.memoryLaunchInfo.set(this.memorySessionKey(sessionId), {
            ...info,
            transcriptMessageCount: 0,
            customTitle: preservedCustomTitle?.trim() || null,
            ...(preservedPermissionMode && VALID_SESSION_PERMISSION_MODES.has(preservedPermissionMode)
              ? { permissionMode: preservedPermissionMode } : {}),
          })
        }
        return
      }
      let found = await this.findSessionFile(sessionId)
      if (!found && fallbackWorkDir) {
        const resolvedPath = path.resolve(normalizeDriveRootPathForPlatform(fallbackWorkDir))
        const absWorkDir = await fs.realpath(resolvedPath).catch(() => resolvedPath)
        const dirPath = path.join(this.getProjectsDir(), this.sanitizePath(absWorkDir))
        await fs.mkdir(dirPath, { recursive: true })
        found = {
          filePath: path.join(dirPath, `${sessionId}.jsonl`),
          projectDir: this.sanitizePath(absWorkDir),
        }
      }
      if (!found) {
        throw ApiError.notFound(`Session not found: ${sessionId}`)
      }

      // Only the newest metadata survives a clear. Walk the transcript one
      // record at a time so a large session is not parsed into one array.
      const preserved = { workDir: undefined as string | undefined, cwd: undefined as string | undefined,
        repository: undefined as PreparedSessionWorkspace['repository'] | undefined,
        permissionMode: undefined as string | undefined }
      await streamBoundedHistory(found.filePath, entry => {
        const record = entry as RawEntry
        if (record.type === 'session-meta') {
          if (typeof (record as Record<string, unknown>).workDir === 'string') preserved.workDir = (record as Record<string, unknown>).workDir as string
          if (typeof record.permissionMode === 'string' && VALID_SESSION_PERMISSION_MODES.has(record.permissionMode)) preserved.permissionMode = record.permissionMode
        }
        if (typeof record.cwd === 'string' && record.cwd.trim()) preserved.cwd = record.cwd
        const repository = (record as Record<string, unknown>).repository
        if (repository && typeof repository === 'object') preserved.repository = repository as PreparedSessionWorkspace['repository']
      }, undefined, { maxRecordBytes: HISTORY_SEMANTIC_RECORD_BYTES }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      const workDir = (preserved.workDir && normalizeDriveRootPathForPlatform(preserved.workDir))
        || (preserved.cwd && normalizeDriveRootPathForPlatform(preserved.cwd))
        || this.desanitizePath(found.projectDir) || fallbackWorkDir || process.cwd()
      const repository = preserved.repository
      const permissionMode = (
        preservedPermissionMode &&
        VALID_SESSION_PERMISSION_MODES.has(preservedPermissionMode)
      )
        ? preservedPermissionMode
        : preserved.permissionMode
      const now = new Date().toISOString()

      const initialEntry = {
        type: 'file-history-snapshot',
        messageId: crypto.randomUUID(),
        snapshot: {
          messageId: crypto.randomUUID(),
          trackedFileBackups: {},
          timestamp: now,
        },
        isSnapshotUpdate: false,
      }

      const metaEntry = {
        type: 'session-meta',
        isMeta: true,
        workDir,
        repository,
        ...(permissionMode ? { permissionMode } : {}),
        timestamp: now,
      }

      const customTitleEntry = preservedCustomTitle?.trim()
        ? {
            type: 'custom-title',
            customTitle: preservedCustomTitle.trim(),
            timestamp: now,
          }
        : null

      if (!this.shouldPersistSession()) return
      this.memoryLaunchInfo.delete(this.memorySessionKey(sessionId))
      await fs.writeFile(
        found.filePath,
        [initialEntry, metaEntry, ...(customTitleEntry ? [customTitleEntry] : [])]
          .map(entry => JSON.stringify(entry))
          .join('\n') + '\n',
        'utf-8',
      )
      if (customTitleEntry) {
        this.syncIndexedSessionTitle(sessionId, customTitleEntry.customTitle)
      }
      this.invalidateSessionListCache()
    } catch (error) {
      // Clear aborts old-generation appends so none can land after a successful
      // transcript replacement. If replacement itself fails, restore any
      // terminal notification that the barrier interrupted; otherwise a
      // previously persisted running Agent can reappear after restart.
      this.clearingTaskNotificationSessions.delete(sessionId)
      await Promise.allSettled(
        pendingWrites
          .filter((pending) => !pending.persisted)
          .map((pending) =>
            this.appendSessionTaskNotification(sessionId, pending.notification)),
      )
      throw error
    } finally {
      this.clearingTaskNotificationSessions.delete(sessionId)
    }
  }

  async appendSessionMetadata(
    sessionId: string,
    metadata: {
      workDir: string
      customTitle?: string | null
      repository?: PreparedSessionWorkspace['repository']
      permissionMode?: string
      runtimeProviderId?: string | null
      runtimeModelId?: string
      effortLevel?: string
    }
  ): Promise<void> {
    const persist = this.shouldPersistSession()
    const storedInfo = await this.getSessionLaunchInfo(sessionId)
    if (storedInfo) this.knownSessionKeys.add(this.memorySessionKey(sessionId))
    const workDir = normalizeDriveRootPathForPlatform(metadata.workDir)
    const projectDir = this.sanitizePath(workDir)
    const previousInfo = storedInfo ?? (!persist ? {
      filePath: path.join(this.getProjectsDir(), projectDir, `${sessionId}.jsonl`),
      projectDir, workDir, transcriptMessageCount: 0, customTitle: null,
    } : null)
    if (previousInfo && (!persist || !this.shouldPersistSession() || this.memoryLaunchInfo.has(this.memorySessionKey(sessionId)))) {
      const normalizedWorkDir = normalizeDriveRootPathForPlatform(metadata.workDir)
      const projectDir = this.sanitizePath(normalizedWorkDir)
      this.memoryLaunchInfo.set(this.memorySessionKey(sessionId), {
        ...previousInfo,
        workDir: normalizedWorkDir, projectDir,
        filePath: path.join(this.getProjectsDir(), projectDir, `${sessionId}.jsonl`),
        ...(metadata.repository ? { repository: metadata.repository } : {}),
        ...(metadata.customTitle ? { customTitle: metadata.customTitle } : {}),
        ...(metadata.permissionMode && VALID_SESSION_PERMISSION_MODES.has(metadata.permissionMode)
          ? { permissionMode: metadata.permissionMode } : {}),
        ...(metadata.runtimeProviderId !== undefined ? { runtimeProviderId: metadata.runtimeProviderId } : {}),
        ...(metadata.runtimeModelId ? { runtimeModelId: metadata.runtimeModelId } : {}),
        ...(metadata.effortLevel && VALID_SESSION_EFFORT_LEVELS.has(metadata.effortLevel)
          ? { effortLevel: metadata.effortLevel } : {}),
      })
    }
    if (!persist || !this.shouldPersistSession()) {
      if (metadata.customTitle) this.rememberPrivateTitle(sessionId, metadata.customTitle)
      return
    }
    const matches = await this.findSessionFiles(sessionId)
    if (matches.length === 0) return

    let repository = metadata.repository
    if (!repository) {
      for (const match of matches) {
        const candidate = (await this.getMetadataProjection(match.filePath, match.projectDir)).launchInfo.repository
        if (candidate) {
          repository = candidate
          break
        }
      }
    }

    const normalizedWorkDir = normalizeDriveRootPathForPlatform(metadata.workDir)
    const targetProjectDir = this.sanitizePath(normalizedWorkDir)
    const requestedFilePath = path.join(this.getProjectsDir(), targetProjectDir, `${sessionId}.jsonl`)
    // A session has one transcript. Startup can still name the directory it was
    // launched from after the CLI has moved into its worktree and written the
    // conversation there; metadata belongs on that file, not on a second copy.
    let targetFilePath = requestedFilePath
    for (const match of matches) {
      if (match.filePath === requestedFilePath) continue
      const entries = await this.readJsonlFile(match.filePath)
      if (this.hasConversationTranscript(entries)) {
        targetFilePath = match.filePath
        break
      }
    }

    // Startup names the directory the session was launched from, so a
    // collaboration title can land on that placeholder. Once the conversation
    // lives in another transcript, keep the title with the file that survives
    // placeholder cleanup instead of letting the only copy be deleted.
    let customTitle = metadata.customTitle ?? null
    if (!customTitle) {
      const target = matches.find((match) => match.filePath === targetFilePath)
      const targetTitle = target
        ? (await this.getMetadataProjection(target.filePath, target.projectDir)).customTitle
        : null
      if (!targetTitle) {
        for (const match of matches) {
          if (match.filePath === targetFilePath) continue
          const title = (await this.getMetadataProjection(match.filePath, match.projectDir)).customTitle
          if (title) {
            customTitle = title
            break
          }
        }
      }
    }

    if (!customTitle && !this.memoryLaunchInfo.has(this.memorySessionKey(sessionId))) {
      if (this.metadataMatchesLaunchInfo(previousInfo, {
        ...metadata,
        workDir: normalizedWorkDir,
        repository,
      })) {
        return
      }
    }

    await fs.mkdir(path.dirname(targetFilePath), { recursive: true })

    await this.appendJsonlEntry(targetFilePath, {
      type: 'session-meta',
      isMeta: true,
      workDir: normalizedWorkDir,
      repository,
      ...(metadata.permissionMode && VALID_SESSION_PERMISSION_MODES.has(metadata.permissionMode)
        ? { permissionMode: metadata.permissionMode }
        : {}),
      ...(metadata.runtimeProviderId !== undefined
        ? { runtimeProviderId: metadata.runtimeProviderId }
        : {}),
      ...(metadata.runtimeModelId ? { runtimeModelId: metadata.runtimeModelId } : {}),
      ...(metadata.effortLevel && VALID_SESSION_EFFORT_LEVELS.has(metadata.effortLevel)
        ? { effortLevel: metadata.effortLevel }
        : {}),
      timestamp: new Date().toISOString(),
    })

    if (customTitle && this.canPersistTitle(sessionId, customTitle)) {
      await this.appendJsonlEntry(targetFilePath, {
        type: 'custom-title',
        customTitle,
        timestamp: new Date().toISOString(),
      })
      this.syncIndexedSessionTitle(sessionId, customTitle)
    }
    this.invalidateSessionListCache()
  }

  async deletePlaceholderSessionFiles(
    sessionId: string,
    keepWorkDir: string,
  ): Promise<number> {
    if (!this.isValidSessionId(sessionId)) return 0

    const projectsDir = this.getProjectsDir()
    let projectDirs: import('node:fs').Dirent[]
    try {
      projectDirs = await fs.readdir(projectsDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }

    const keepProjectDir = this.sanitizePath(normalizeDriveRootPathForPlatform(keepWorkDir))
    let removed = 0
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue
      if (projectDir.name === keepProjectDir) continue
      const filePath = path.join(projectsDir, projectDir.name, `${sessionId}.jsonl`)
      const entries = await this.readJsonlFile(filePath)
      if (entries.length === 0) continue

      if (this.hasConversationTranscript(entries)) continue

      await fs.rm(filePath, { force: true })
      removed += 1
    }
    if (removed > 0) this.invalidateSessionListCache()
    return removed
  }

  async trimSessionMessagesFrom(
    sessionId: string,
    startMessageId: string,
  ): Promise<TrimSessionResult> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    const activeMessages = this.entriesToMessages(entries)
    const startIndex = activeMessages.findIndex((message) => message.id === startMessageId)

    if (startIndex < 0) {
      throw ApiError.badRequest(`Message not found in active session chain: ${startMessageId}`)
    }

    const removedMessageIds = activeMessages
      .slice(startIndex)
      .map((message) => message.id)
    const remainingMessageIds = new Set(
      activeMessages
        .slice(0, startIndex)
        .map((message) => message.id),
    )

    if (removedMessageIds.length === 0) {
      return { removedCount: 0, removedMessageIds: [] }
    }

    const removedIds = new Set(removedMessageIds)
    const kept = (entry: RawEntry): boolean => {
      if (typeof entry.uuid !== 'string') return true
      if (removedIds.has(entry.uuid)) return false
      if (
        entry.message?.role &&
        (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system')
      ) {
        return remainingMessageIds.has(entry.uuid)
      }
      return true
    }
    // Copy the original lines that survive. Re-serializing every retained entry
    // would hold the whole transcript as one string on the request thread.
    const transcriptStats = await fs.stat(found.filePath)
    const tempFilePath = `${found.filePath}.rewind-${crypto.randomUUID()}.tmp`
    const output = createWriteStream(tempFilePath, { mode: transcriptStats.mode })
    let failed = false
    const fail = (error: Error) => { if (!failed) { failed = true; output.destroy(error) } }
    try {
      await new Promise<void>((resolve, reject) => {
        output.on('error', reject)
        output.on('finish', resolve)
        void (async () => {
          const input = createReadStream(found.filePath, { encoding: 'utf8' })
          try {
            for await (const line of createInterface({ input, crlfDelay: Infinity })) {
              if (line.trim()) {
                try {
                  if (!kept(JSON.parse(line) as RawEntry)) continue
                } catch { /* Keep a line the transcript reader would also keep. */ }
              }
              if (!output.write(`${line}\n`)) await new Promise<void>(resume => output.once('drain', resume))
            }
            output.end()
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          } finally {
            input.destroy()
          }
        })()
      })
      if (!this.shouldPersistSession()) return { removedCount: 0, removedMessageIds: [] }
      await fs.rename(tempFilePath, found.filePath)
    } finally {
      output.destroy()
      await fs.rm(tempFilePath, { force: true })
    }
    this.invalidateSessionListCache()

    return {
      removedCount: removedMessageIds.length,
      removedMessageIds,
    }
  }

  async getSessionFileHistorySnapshots(
    sessionId: string,
    options: { bounded?: boolean } = {},
  ): Promise<FileHistorySnapshot[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    let entries: RawEntry[]
    if (options.bounded) {
      const stat = await fs.stat(found.filePath, { bigint: true })
      // The transcript is immutable between polls, but its interpreted token budget
    // also depends on editable provider settings and process-level overrides.
    const providers = await this.providerService.listProviders().catch(() => null)
    const contextRevision = createHash('sha256').update(JSON.stringify({
      activeId: providers?.activeId,
      providers: providers?.providers.map(provider => ({
        id: provider.id,
        models: provider.models,
        modelContextWindows: provider.modelContextWindows,
        model1mSupport: provider.model1mSupport,
        autoCompactWindow: provider.autoCompactWindow,
      })),
      env: [
        MODEL_CONTEXT_WINDOWS_ENV_KEY, 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
        'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'USER_TYPE', 'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_AZURE_OPENAI',
      ].map(name => process.env[name] ?? null),
    })).digest('hex')
    const key = `${found.filePath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${contextRevision}`
      let request = this.uiFileHistoryReads.get(key)
      if (!request) {
        request = (async () => {
          const selected: RawEntry[] = []
          let bytes = 0
          await this.streamJsonlFile(found.filePath, entry => {
            if (entry.type !== 'file-history-snapshot') return
            bytes += Buffer.byteLength(JSON.stringify(entry))
            if (bytes > 2 * 1024 * 1024 || selected.length >= 1000) {
              throw new ApiError(413, 'File history exceeds its viewing budget', 'HISTORY_WORKSPACE_LIMIT')
            }
            selected.push(entry)
          })
          return selected
        })()
        this.uiFileHistoryReads.set(key, request)
        while (this.uiFileHistoryReads.size > 8) this.uiFileHistoryReads.delete(this.uiFileHistoryReads.keys().next().value!)
      }
      try { entries = await request }
      catch (error) { this.uiFileHistoryReads.delete(key); throw error }
    } else {
      entries = await this.readTargetedJsonlEntries(found, ['file-history-snapshot']) ?? await this.readJsonlFile(found.filePath)
    }
    const snapshotsByMessageId = new Map<string, FileHistorySnapshot>()

    for (const entry of entries) {
      if (entry.type !== 'file-history-snapshot' || !entry.snapshot) continue

      const snapshotMessageId =
        typeof entry.snapshot.messageId === 'string'
          ? entry.snapshot.messageId
          : typeof entry.messageId === 'string'
            ? entry.messageId
            : null

      if (!snapshotMessageId) continue

      const beforeMapValid = !!entry.snapshot.trackedFileBackups && typeof entry.snapshot.trackedFileBackups === 'object' && !Array.isArray(entry.snapshot.trackedFileBackups)
      snapshotsByMessageId.set(snapshotMessageId, migrateFileHistorySnapshot({
        messageId: snapshotMessageId as FileHistorySnapshot['messageId'],
        trackedFileBackups: beforeMapValid ? entry.snapshot.trackedFileBackups as FileHistorySnapshot['trackedFileBackups'] : {},
        ...(!beforeMapValid ? { [malformedFileHistoryBefore]: true } : {}),
        // A corrupt completion marker must not become a legacy before-only
        // record that can silently fall through to another turn's boundary.
        ...(Object.prototype.hasOwnProperty.call(entry.snapshot, 'completedFileBackups') ? {
          completedFileBackups: entry.snapshot.completedFileBackups && typeof entry.snapshot.completedFileBackups === 'object' && !Array.isArray(entry.snapshot.completedFileBackups)
            ? entry.snapshot.completedFileBackups as FileHistorySnapshot['completedFileBackups']
            : {},
        } : {}),
        timestamp: new Date(
          entry.snapshot.timestamp || entry.timestamp || new Date().toISOString(),
        ),
      }))
    }

    return [...snapshotsByMessageId.values()]
  }

  async appendSessionTaskNotification(
    sessionId: string,
    notification: SessionTaskNotification,
  ): Promise<void> {
    const normalized = this.parsePersistedTaskNotification(
      notification,
      notification.timestamp ?? new Date(this.now()).toISOString(),
    )
    if (!normalized || !this.shouldPersistSession()) return
    if (this.clearingTaskNotificationSessions.has(sessionId)) return

    const epoch = this.taskNotificationMutationEpochs.get(sessionId) ?? 0
    const controller = new AbortController()
    const pending = {
      controller,
      promise: Promise.resolve(),
      notification: normalized,
      persisted: false,
    }
    const write = (async () => {
      const found = await this.findSessionFile(sessionId)
      if (
        !found ||
        controller.signal.aborted ||
        this.clearingTaskNotificationSessions.has(sessionId) ||
        (this.taskNotificationMutationEpochs.get(sessionId) ?? 0) !== epoch
      ) {
        return
      }

      await this.appendJsonlEntry(found.filePath, {
        type: PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE,
        isMeta: true,
        taskNotification: normalized,
        timestamp: normalized.timestamp,
      }, controller.signal)
      pending.persisted = true
      this.invalidateSessionListCache()
    })()
    pending.promise = write

    let writes = this.pendingTaskNotificationWrites.get(sessionId)
    if (!writes) {
      writes = new Set()
      this.pendingTaskNotificationWrites.set(sessionId, writes)
    }
    writes.add(pending)
    try {
      await write
    } finally {
      writes.delete(pending)
      if (writes.size === 0) this.pendingTaskNotificationWrites.delete(sessionId)
    }
  }

  async getSessionTaskNotifications(
    sessionId: string,
  ): Promise<SessionTaskNotification[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readTargetedJsonlEntries(
      found,
      ['user', PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE],
    ) ?? await this.readJsonlFile(found.filePath)
    return this.taskNotificationsFromEntries(entries)
  }

  private taskNotificationsFromEntries(
    entries: RawEntry[],
  ): SessionTaskNotification[] {
    const notifications = new Map<string, SessionTaskNotification>()
    for (const entry of entries) {
      const notification = entry.type === PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE
        ? this.parsePersistedTaskNotification(entry.taskNotification, entry.timestamp)
        : entry.message?.role === 'user'
          ? this.parseTaskNotificationContent(entry.message.content, entry.timestamp)
          : null
      if (notification) {
        notifications.set(sessionTaskNotificationIdentity(notification), notification)
      }
    }
    return [...notifications.values()]
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private entriesToMessages(entries: RawEntry[]): MessageEntry[] {
    const messages: MessageEntry[] = []
    const entriesByUuid = new Map<string, RawEntry>()
    const parentToolUseIdCache = new Map<string, string | undefined>()
    let suppressTaskNotificationResponse = false

    for (const entry of entries) {
      if (typeof entry.uuid === 'string' && entry.uuid.length > 0) {
        entriesByUuid.set(entry.uuid, entry)
      }
    }

    for (const entry of entries) {
      const goalLocalCommandMessage = this.goalLocalCommandEntryToMessage(entry)
      if (goalLocalCommandMessage) {
        messages.push(goalLocalCommandMessage)
        continue
      }

      // Only process transcript entries (user / assistant / system with messages)
      if (!entry.message?.role) continue

      // Skip meta entries (CLI internal bookkeeping). Collaboration deliveries
      // are the exception: the isMeta prompt carries a real cross-session
      // message that must render as an ordinary user-position bubble.
      if (entry.isMeta && !parseSessionCollaborationEnvelope(entry.message.content)) continue

      const isTaskNotification =
        entry.message.role === 'user' &&
        this.isTaskNotificationContent(entry.message.content)
      if (isTaskNotification) {
        suppressTaskNotificationResponse = true
        continue
      }

      if (
        entry.message.role === 'user' &&
        !this.isToolResultContent(entry.message.content)
      ) {
        suppressTaskNotificationResponse = false
      } else if (suppressTaskNotificationResponse) {
        continue
      }

      if (this.shouldHideTranscriptEntry(entry)) continue

      // Skip non-transcript entry types
      const entryType = entry.type
      if (
        entryType !== 'user' &&
        entryType !== 'assistant' &&
        entryType !== 'system'
      ) {
        continue
      }

      const parentToolUseId = this.resolveParentToolUseId(
        entry,
        entriesByUuid,
        parentToolUseIdCache,
      )
      const msg = this.entryToMessage(entry, parentToolUseId)
      if (msg) {
        messages.push(msg)
      }
    }
    return messages
  }

  private async pathExists(targetPath: string | null): Promise<boolean> {
    if (!targetPath) return false

    try {
      const stat = await fs.stat(targetPath)
      return stat.isDirectory()
    } catch {
      return false
    }
  }

  private createCachedPathExists(): (targetPath: string | null) => Promise<boolean> {
    const cache = new Map<string, Promise<boolean>>()
    return (targetPath) => {
      if (!targetPath) return Promise.resolve(false)
      const key = targetPath.normalize('NFC')
      const cached = cache.get(key)
      if (cached) return cached
      const pending = this.pathExists(targetPath)
      cache.set(key, pending)
      return pending
    }
  }

  private async resolveWorkspaceAvailability({
    workDir,
    projectRoot,
    worktreeSession,
    repository,
    pathExists = (targetPath: string | null) => this.pathExists(targetPath),
  }: {
    workDir: string | null
    projectRoot: string | null
    worktreeSession?: PersistedWorktreeSession | null
    repository?: PreparedSessionWorkspace['repository']
    pathExists?: (targetPath: string | null) => Promise<boolean>
  }): Promise<{ workDirExists: boolean; workspaceState: SessionWorkspaceState }> {
    const workDirExists = await pathExists(workDir)
    if (workDirExists) {
      return { workDirExists: true, workspaceState: 'available' }
    }

    const projectRootIsDifferent = !this.sameWorkspacePath(workDir, projectRoot)
    const projectRootExists = projectRootIsDifferent && await pathExists(projectRoot)
    const removedPersistedWorktree = projectRootExists && this.matchesPersistedWorktree({
      workDir,
      projectRoot,
      worktreeSession,
      repository,
    })

    return {
      workDirExists: false,
      workspaceState: removedPersistedWorktree ? 'worktree_removed' : 'missing',
    }
  }

  private matchesPersistedWorktree({
    workDir,
    projectRoot,
    worktreeSession,
    repository,
  }: {
    workDir: string | null
    projectRoot: string | null
    worktreeSession?: PersistedWorktreeSession | null
    repository?: PreparedSessionWorkspace['repository']
  }): boolean {
    if (!workDir || !projectRoot) return false
    if (this.sameWorkspacePath(workDir, worktreeSession?.worktreePath)) return true
    if (
      repository?.worktree &&
      this.sameWorkspacePath(workDir, repository.worktreePath)
    ) {
      return true
    }

    const normalizedWorkDir = this.normalizeWorkspacePath(workDir)
    const marker = '/.claude/worktrees/'
    const markerIndex = normalizedWorkDir.indexOf(marker)
    if (markerIndex <= 0) return false
    return this.sameWorkspacePath(
      normalizedWorkDir.slice(0, markerIndex),
      projectRoot,
    )
  }

  private sameWorkspacePath(
    left: string | null | undefined,
    right: string | null | undefined,
  ): boolean {
    if (!left || !right) return false
    return this.normalizeWorkspacePath(left) === this.normalizeWorkspacePath(right)
  }

  private normalizeWorkspacePath(targetPath: string): string {
    const normalized = normalizeDriveRootPathForPlatform(targetPath)
      .normalize('NFC')
      .replace(/\\/g, '/')
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  }
}

// Singleton instance for shared use across API handlers
export const sessionService = new SessionService()
