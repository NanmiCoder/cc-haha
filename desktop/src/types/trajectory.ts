/**
 * Wire contract for the per-session trajectory (轨迹) view.
 *
 * Mirrors `src/server/services/trajectoryTypes.ts`; keep the two in sync.
 */

export type TrajectoryRowKind = 'system' | 'user' | 'context' | 'assistant' | 'tool' | 'compact'

/** `[byteStart, byteEnd)` of one JSONL record in the source transcript. */
export type TrajectoryLoc = [number, number]

export type TrajectoryUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type TrajectorySnapshotChange = 'initial' | 'system' | 'tools' | 'system+tools' | 'context'

export type TrajectorySnapshotRef = {
  scope: string
  change: TrajectorySnapshotChange
  sys?: string
  tools?: string
  ctx?: string
  prevSys?: string
  prevTools?: string
  prevCtx?: string
  querySource?: string
  model?: string
  toolCount?: number
  sysChars?: number
}

export type TrajectoryRow = {
  id: string
  kind: TrajectoryRowKind
  /** Absolute 1-based turn; 0 before the first prompt; null when unknown. */
  turn: number | null
  ts: string
  endTs?: string
  label?: string
  preview: string
  loc: TrajectoryLoc[]
  partial?: boolean
  isError?: boolean

  toolName?: string
  toolUseId?: string
  parentId?: string
  inputPreview?: string
  /** The identifying argument as plain text (command, path, pattern, url...). */
  inputSummary?: string
  resultPreview?: string
  resultTs?: string
  /** The result record exists but was too large to load (bytes). */
  resultOmittedBytes?: number
  agentId?: string

  messageId?: string
  requestId?: string
  model?: string
  usage?: TrajectoryUsage
  startTs?: string
  toolOnly?: boolean
  hasThinking?: boolean
  stopReason?: string

  attachmentType?: string

  snapshot?: TrajectorySnapshotRef
}

export type TrajectoryPage = {
  rows: TrajectoryRow[]
  snapshots?: TrajectoryRow[]
  turnBase: number | null
  olderCursor: string | null
  tailToken: string
  historyComplete: boolean
  omittedOversizedEntries: number
  sourceMissing?: boolean
}

export type TraceCallsNear = {
  calls: import('./trace').TraceCallRecord[]
  revisionToken?: string
  captured: boolean
  /** callId → `"start-end"` locator, passed as `?at=` to the call-detail route. */
  locs?: Record<string, string>
  /** The scan hit its budget or more than 50 calls matched. */
  limited?: boolean
}

export type TrajectoryRowDetail = {
  rowId: string
  entries: Record<string, unknown>[]
  truncated: boolean
}

export type TrajectorySnapshotBlob = {
  hash: string
  kind: 'sys' | 'tools' | 'ctx'
  text?: string
  json?: unknown
  truncated?: boolean
}
