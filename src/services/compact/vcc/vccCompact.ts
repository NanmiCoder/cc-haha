// Unified algorithmic compaction entry point for cc-haha.
//
// Ports pi-vcc's before-compact summarization to cc-haha: adapt the session
// window to pi message shapes, cut a keep-tail, and compile a
// transcript-preserving structured summary with no LLM call. Returns the
// summary text plus the verbatim-kept tail so the compaction bypass
// (task: bypass the LLM summary step) can thread them into CompactionResult.
//
// The `#N` refs rendered in the summary use the session-global index built
// from the in-memory history (file order), the same rule vcc_recall reads
// from the JSONL — so recall resolves against the summary's refs.
import type { CcMessage } from "./adapter"
import { adaptCcMessages } from "./adapter"
import {
  buildVccCut,
  calibrateFromWindow,
  resolveSmartKeepUserTurns,
} from "./engine"
import { compileRanked } from "./vendor/core/summarize"
import type { FileOps } from "./vendor/types"

// pi-vcc's before-compact ranking budget (0.8.0 hook): brief transcript
// floor 1100 tok, ceiling 2000 tok, 15 tok/block slope, scaled by the
// session-calibrated chars/token.
export const RANKED_BRIEF_BUDGET_TOKENS = 1100
export const RANKED_BRIEF_CEILING_TOKENS = 2000
export const RANKED_BRIEF_TOKENS_PER_BLOCK = 15

const SECTION_HEADERS = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Outstanding Context",
  "User Preferences",
]

// The prefix getCompactUserSummaryMessage prepends to every compact summary.
// On a re-compact the live window's first user message is the previous
// summary (isCompactSummary); strip this prefix to recover the prior VCC
// text for mergePrevious.
const CONTINUATION_PREFIX =
  "This session is being continued from a previous conversation"

/** The previous VCC summary text, or undefined when there is none. */
const extractPreviousSummary = (messages: CcMessage[]): string | undefined => {
  for (const m of messages) {
    const msg = m as any
    if (msg.type !== "user" || !msg.isCompactSummary) continue
    const content = msg.message?.content
    if (typeof content !== "string") continue
    const idx = content.indexOf(CONTINUATION_PREFIX)
    if (idx < 0) return content
    // The prefix line ends after "earlier portion of the conversation."
    const body = content.slice(idx)
    const nl = body.indexOf("\n")
    return nl < 0 ? body : body.slice(nl).trim()
  }
  return undefined
}

/** Which section headers are present in a VCC summary (for diagnostics). */
export const sectionsOf = (summary: string): string[] =>
  SECTION_HEADERS.filter((h) => summary.includes(`[${h}]`))

export interface VccCompactionInput {
  /** The live window to compact (already boundary-projected by the caller). */
  messages: CcMessage[]
  /**
   * Session-global uuid → `#N`. When omitted it is built from `messages`.
   * Pass the full in-memory history's index so `#N` stays global across
   * compactions (matching vcc_recall).
   */
  globalIndexByUuid?: Map<string, number>
  /** Pre-compact token estimate used to calibrate chars/token. */
  preCompactTokenCount?: number
  /**
   * Explicit user keep (from a `keep:N` compaction instruction). When set and
   * > 0 it overrides the smart-keep resolution. `null`/absent = smart keep.
   */
  keepUserTurns?: number | null
}

export interface VccCompactionOutput {
  /** The compiled summary (sections + `---` + brief transcript + recall note). */
  summary: string
  /** The verbatim-kept tail (passed back as messagesToKeep). */
  messagesToKeep: CcMessage[]
  keptUserTurns: number
  totalUserTurns: number
  budgetCut: "none" | "no_anchor" | "oversized_tail"
  /** Number of pi messages summarized (for diagnostics/telemetry). */
  sourceMessageCount: number
  previousSummaryUsed: boolean
  sections: string[]
}

/**
 * Run algorithmic compaction over the live window. Pure (no LLM, no IO):
 * cut → adapt → compileRanked. The caller is responsible for boundary
 * markers, attachments, and hooks (see the compactConversation bypass).
 */
export const runVccCompaction = (input: VccCompactionInput): VccCompactionOutput => {
  const { messages } = input
  const globalIndexByUuid =
    input.globalIndexByUuid ??
    buildIndexFromMessages(messages)

  const adapted = adaptCcMessages(messages, globalIndexByUuid)
  const calibration = calibrateFromWindow(
    adapted.messages,
    input.preCompactTokenCount,
  )
  const keep =
    input.keepUserTurns != null && input.keepUserTurns > 0
      ? {
          keepUserTurns: input.keepUserTurns,
          smartAdjusted: false,
          fromKeep: input.keepUserTurns,
        }
      : resolveSmartKeepUserTurns(adapted.messages, calibration)

  const cut = buildVccCut(
    adapted.messages,
    adapted.sourceIndices,
    adapted.ccIndices,
    keep.keepUserTurns,
    { charsPerToken: calibration.charsPerToken },
  )

  const previousSummary = extractPreviousSummary(messages)

  if (!cut.ok) {
    // Too few live messages to form a useful summary. Fall back to a
    // compact-all so the caller still produces a boundary.
    const summary = compileRanked({
      messages: adapted.messages,
      sourceIndices: adapted.sourceIndices,
      previousSummary,
      fileOps: adapted.fileOps,
      ranking: rankingFor(adapted.fileOps, calibration.charsPerToken),
    })
    return {
      summary,
      messagesToKeep: [],
      keptUserTurns: 0,
      totalUserTurns: cut.totalUserTurns,
      budgetCut: "no_anchor",
      sourceMessageCount: adapted.messages.length,
      previousSummaryUsed: previousSummary != null,
      sections: sectionsOf(summary),
    }
  }
  const summary = compileRanked({
    messages: cut.toSummarize,
    sourceIndices: cut.toSummarizeIndices,
    previousSummary,
    fileOps: adapted.fileOps,
    ranking: rankingFor(adapted.fileOps, calibration.charsPerToken),
  })

  return {
    summary,
    messagesToKeep: messages.slice(cut.keptCcStart),
    keptUserTurns: cut.keptUserTurns,
    totalUserTurns: cut.totalUserTurns,
    budgetCut: cut.budgetCut,
    sourceMessageCount: cut.toSummarize.length,
    previousSummaryUsed: previousSummary != null,
    sections: sectionsOf(summary),
  }
}

const rankingFor = (
  fileOps: FileOps,
  cpt: number,
) => ({
  maxBriefChars: RANKED_BRIEF_BUDGET_TOKENS * cpt,
  maxBriefCharsCeiling: RANKED_BRIEF_CEILING_TOKENS * cpt,
  briefCharsPerBlock: RANKED_BRIEF_TOKENS_PER_BLOCK * cpt,
  fileOps,
})

/** Build the session-global uuid → `#N` map from a message array. */
const buildIndexFromMessages = (
  messages: CcMessage[],
): Map<string, number> => {
  const byUuid = new Map<string, number>()
  let index = 0
  for (const m of messages) {
    if (m.type !== "user" && m.type !== "assistant") continue
    const uuid = (m as any).uuid
    if (typeof uuid === "string" && uuid && !byUuid.has(uuid))
      byUuid.set(uuid, index)
    index++
  }
  return byUuid
}
