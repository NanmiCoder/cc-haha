import type { SessionProtocolState } from '../../../shared/sessionProtocol.js'
export type LocalIndexMode = 'off' | 'shadow' | 'on'
export type LocalIndexState = 'off' | 'building' | 'ready' | 'degraded'

export type LocalIndexStatus = {
  mode: LocalIndexMode
  state: LocalIndexState
  discovered: number
  indexed: number
  degradedSources: number
  databaseBytes: number
  walBytes: number
  lastUpdatedAt: string | null
  lastErrorCode: string | null
}

export type PersistedRepositorySession = {
  requestedWorkDir: string
  repoRoot: string
  branch: string
  worktree: boolean
  baseRef: string
  worktreePath?: string
  worktreeBranch?: string
  worktreeSlug?: string
}

export type PersistedWorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
}

export type SessionListSummary = {
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  workDir: string | null
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
  sessionApiFormat?: SessionProtocolState
  repository?: PersistedRepositorySession
  worktreeSession?: PersistedWorktreeSession | null
}

export type TranscriptChunk = {
  text: string
  byteStart: number
  byteLength?: number
  completeLine: boolean
}

export type TranscriptEntryLocator = {
  ordinal: number
  jsonlLine: number
  byteStart: number
  byteLength: number
  entryType: string
  messageId: string | null
  role: string | null
  timestamp: string | null
  parentToolUseId: string | null
}

export type ActivityDailyProjection = {
  date: string
  messageCount: number
  toolCallCount: number
}

export type ActivityModelProjection = {
  date: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}

export type ActivityNamedUsageProjection = {
  date: string
  name: string
  count: number
}

export type TranscriptActivityProjection = {
  isSubagent: boolean
  firstTimestamp: string | null
  lastTimestamp: string | null
  /**
   * Time actually spent working, summed over gaps between consecutive messages that are shorter
   * than `ACTIVE_SESSION_GAP_MS`. `lastTimestamp - firstTimestamp` is a calendar span, not a
   * duration: a session resumed the next morning would report the whole night as task time.
   */
  activeDurationMs: number
  messageCount: number
  startHour: number | null
  speculationTimeSavedMs: number
  shotCount: number | null
  daily: ActivityDailyProjection[]
  models: ActivityModelProjection[]
  tools: ActivityNamedUsageProjection[]
  skills: ActivityNamedUsageProjection[]
}

export type TranscriptProjection = {
  summary: SessionListSummary
  indexedBytes: number
  pendingTailBytes: number
  malformedLineCount: number
  activity?: TranscriptActivityProjection
}
