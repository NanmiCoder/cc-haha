/**
 * Wire contract for the per-session trajectory (轨迹) view.
 *
 * The desktop mirrors these types in `desktop/src/types/trajectory.ts`; keep
 * the two in sync. Rows are a compact projection of the transcript JSONL plus
 * the `prompt-snapshots.jsonl` sidecar — full bodies are fetched per row.
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
  /** `main` or the subagent id the request belonged to. */
  scope: string
  change: TrajectorySnapshotChange
  sys?: string
  tools?: string
  ctx?: string
  /** Hashes of the previous snapshot in the same scope, for the diff tab. */
  prevSys?: string
  prevTools?: string
  prevCtx?: string
  querySource?: string
  model?: string
  toolCount?: number
  sysChars?: number
}

/**
 * One ledger row. Ids are stable across pages and live appends:
 *   u:<uuid>         user prompt (or queued/steering input)
 *   c:<uuid>         context injection (attachment, isMeta user, compact summary, api error)
 *   a:<message.id>   one assistant API response (its block lines are merged)
 *   t:<tool_use_id>  one tool call, paired with its tool_result
 *   m:<uuid>         compact / microcompact boundary
 *   s:<scope>:<n>    prompt snapshot change (system prompt / tools / user context)
 *
 * The server may emit the same id more than once (a page boundary splits an
 * assistant message, or a tool_result lands in a later page/append). Such
 * pieces are marked `partial` and the client merges them by id.
 */
export type TrajectoryRow = {
  id: string
  kind: TrajectoryRowKind
  /** Absolute 1-based turn; 0 before the first prompt; null when unknown. */
  turn: number | null
  /** ISO timestamp of the first record of this row. */
  ts: string
  /** ISO timestamp of the last record of this row (assistant: last block). */
  endTs?: string
  /**
   * Sub label shown next to the badge. Context rows: the attachment type, or
   * `skill`, `meta`, `summary`, `user_context`, `task_notification`,
   * `command_output`, `interrupted`, `api_error`, `api_retry`,
   * `local_command`, `hook_summary`, `stream_retry`, `informational`,
   * `away_summary`, `scheduled_task`. User rows: `queued`, `command`,
   * `session_message` (a message delivered from another session/teammate).
   */
  label?: string
  /** Single-line-safe preview, at most 512 chars. Markdown markers are stripped for assistant text. */
  preview: string
  loc: TrajectoryLoc[]
  partial?: boolean
  isError?: boolean

  // tool
  toolName?: string
  toolUseId?: string
  /** `a:<message.id>` of the assistant response that issued this call. */
  parentId?: string
  inputPreview?: string
  /**
   * The argument that identifies the call, as plain text (command, file path,
   * pattern, url, description...). Absent when no known field applies.
   */
  inputSummary?: string
  resultPreview?: string
  resultTs?: string
  /**
   * The tool_result record exists but exceeded the reader's record budget
   * (typically a screenshot), so its content was not loaded. Byte size of
   * that record.
   */
  resultOmittedBytes?: number
  /** Subagent id launched by an Agent/Task tool call, when known. */
  agentId?: string

  // assistant
  messageId?: string
  requestId?: string
  model?: string
  usage?: TrajectoryUsage
  /** Timestamp of the record preceding this response — the request start estimate. */
  startTs?: string
  /** No text block (only tool_use / thinking). Merged with AND across pieces. */
  toolOnly?: boolean
  hasThinking?: boolean
  stopReason?: string

  // context
  attachmentType?: string

  // system / user-context snapshot rows
  snapshot?: TrajectorySnapshotRef
}

export type TrajectoryPage = {
  rows: TrajectoryRow[]
  /**
   * Present on the tail read and on `after` appends: the complete snapshot row
   * set for the requested scope. When present it replaces the client's set.
   */
  snapshots?: TrajectoryRow[]
  /** Turns completed before the first row of this response; null if unknown. */
  turnBase: number | null
  /** Cursor for the next older page, null at the head of the file. */
  olderCursor: string | null
  /** Opaque token for `?after=` live appends from the current end of file. */
  tailToken: string
  historyComplete: boolean
  omittedOversizedEntries: number
  /** The transcript file does not exist (yet). */
  sourceMissing?: boolean
}

/**
 * `GET /api/sessions/:id/trace/near?from=<iso>&to=<iso>`: captured model
 * calls whose start time falls in the window, oldest first, at most 50.
 * Located by time through the trace index, so it works for captures far
 * larger than one overview window.
 */
export type TraceCallsNear = {
  /** Trace call shells (same shape as the overview's `calls`). */
  calls: unknown[]
  /** Revision key to pass to the call-detail cache. */
  revisionToken?: string
  /** False when the session has no capture file at all. */
  captured: boolean
  /**
   * callId → `"<byteStart>-<byteEnd>"` locator of the call's record. Pass it
   * as `?at=` to `GET /api/sessions/:id/trace/calls/:callId` so the detail
   * read reaches calls outside the overview's indexed window.
   */
  locs?: Record<string, string>
  /**
   * The bounded scan stopped on its byte/record budget, or more than 50
   * calls matched: the window may contain calls that are not listed.
   */
  limited?: boolean
}

export type TrajectoryRowDetail = {
  rowId: string
  /** Raw transcript records of the row in file order, string fields bounded. */
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
