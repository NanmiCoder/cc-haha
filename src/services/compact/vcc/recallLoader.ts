// cc-haha loader for the vcc_recall tool.
//
// The compaction path already maps cc-haha session rows to the pi message
// shapes the vendored core reads (src/adapter.ts), numbering every emitted
// pi message with its session-global `#N` (src/ccGlobalIndex.ts). This loader
// reuses that exact mapping so recall's `#N` refs resolve against the same
// index space the summary's `(#N)` markers use — the two agree by
// construction, no second counting rule.
//
// cc-haha's session JSONL lines ARE the messages
// (`{type:"user"|"assistant", uuid, message:{role, content}}`). `#N` is the
// 0-based position of a user/assistant line among all such lines, in file
// order. Because one line can fan out into several pi messages (a user line's
// tool_results, an assistant line's tool calls), several entries share a
// `#N`; `byIndex` keeps the originating line for drill-down (`#N:path`).
import type { CcMessage } from "./adapter"
import { adaptCcMessages } from "./adapter"
import { buildCcGlobalIndexByUuid } from "./ccGlobalIndex"
import type { Message } from "./pi-ai"
import { forEachJsonlLine } from "./vendor/core/jsonl"
import { renderMessage, type RenderedEntry } from "./vendor/core/render-entries"

/** A parsed cc-haha session JSONL row that counts toward the `#N` index. */
export type CcLine = {
  type: string
  uuid?: string
  timestamp?: string
  isCompactSummary?: boolean
  message?: {
    role: "user" | "assistant"
    content:
      | string
      | Array<{ type: string; [k: string]: unknown }>
    [k: string]: unknown
  }
  [k: string]: unknown
}

const countable = (l: unknown): l is CcLine =>
  (l as CcLine)?.message != null &&
  ((l as CcLine)?.type === "user" || (l as CcLine)?.type === "assistant")

const toCcMessage = (l: CcLine): CcMessage => ({
  type: l.type === "assistant" ? "assistant" : "user",
  uuid: l.uuid,
  timestamp: l.timestamp,
  isCompactSummary: l.isCompactSummary,
  message: l.message! as CcMessage["message"],
})

export interface CcLoaded {
  /** Rendered for display/search; each `index` is the session-global `#N`. */
  rendered: RenderedEntry[]
  /** pi messages parallel to `rendered` (same `#N`). */
  rawMessages: Message[]
  /** `#N` → originating cc row (drill-down source). */
  byIndex: Map<number, CcLine>
  /** total counted rows. */
  count: number
}

/**
 * Load a cc-haha session from parsed rows. `#N` numbering, pi message shapes,
 * and the tool_result→bashExecution collapse all come from the compaction
 * adapter, so recall and the summary never disagree about what `#N` means.
 * `full` controls whether rendered summaries are clipped.
 */
export function loadCcSession(
  lines: readonly CcLine[],
  full: boolean,
): CcLoaded {
  const messages = lines.filter(countable)
  const ccMessages = messages.map(toCcMessage)
  const globalIndexByUuid = buildCcGlobalIndexByUuid(messages)
  const { messages: pi, sourceIndices, ccIndices } = adaptCcMessages(
    ccMessages,
    globalIndexByUuid,
  )

  // rendered and rawMessages stay in lockstep (entries[i] ↔ messages[i]) so the
  // vendored search/touched functions can index them in parallel. A pi message
  // with an unresolvable #N (duplicate/missing uuid, fail-closed) is dropped
  // from both — it can't be referenced by #N anyway.
  const rendered: RenderedEntry[] = []
  const rawMessages: Message[] = []
  const byIndex = new Map<number, CcLine>()
  for (let i = 0; i < pi.length; i++) {
    const n = sourceIndices[i]
    if (n === undefined) continue
    rendered.push(renderMessage(pi[i], n, full))
    rawMessages.push(pi[i])
    const line = ccMessages[ccIndices[i]]
    if (line) byIndex.set(n, line)
  }
  return {
    rendered,
    rawMessages,
    byIndex,
    count: messages.length,
  }
}
/**
 * Stream a cc-haha session JSONL file into loaded lines (chunked via
 * forEachJsonlLine so giant sessions stay within memory bounds). Returns
 * `null` when the file does not exist yet (a new session has no persisted
 * rows) — mirroring pi's loadAllMessages empty-result semantics.
 */
export function loadCcSessionFile(
  file: string,
  full: boolean,
): CcLoaded | null {
  const parsed: CcLine[] = []
  let ok: boolean
  try {
    ok = forEachJsonlLine(file, (buf) => {
      if (buf.length === 0) return
      let row: unknown
      try {
        row = JSON.parse(buf.toString("utf8"))
      } catch {
        return
      }
      if (countable(row)) parsed.push(row)
    })
  } catch {
    return null
  }
  if (!ok) return null
  return loadCcSession(parsed, full)
}
