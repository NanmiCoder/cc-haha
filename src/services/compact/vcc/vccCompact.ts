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
import { wrapLongLines } from "./vendor/core/format"
import type { FileOps } from "./vendor/types"

// pi-vcc's before-compact ranking budget (0.8.0 hook): brief transcript
// floor 1100 tok, ceiling 2500 tok, 15 tok/block slope, scaled by the
// session-calibrated chars/token.
//
// The ceiling was raised from upstream's 2000 (2026-09-27). It is inert on the
// slices a partial compaction actually meets -- there the slope term stays under
// the floor, so the budget is the floor and every ceiling >= 1100 gives the same
// output (measured: 1600/2000/2300/2500/3200/3600 all identical at a 60k-char
// slice). It binds only on a slice with more than ~167 ranked blocks, i.e. the
// very large ones, where the extra 500 tokens buy a little more retained detail.
export const RANKED_BRIEF_BUDGET_TOKENS = 1100
export const RANKED_BRIEF_CEILING_TOKENS = 2500
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

/**
 * Sections a whole-window summary can claim but a slice cannot.
 *
 * `Session Goal` and `User Preferences` describe the session, not the span
 * they were read from: compiling them out of one side of a pivot yields the
 * goal of *that side*, printed under a header that promises the session's.
 * That is worse than an omission — it reads as authoritative and is wrong,
 * with nothing in the text to warn the reader. `Files And Changes`, `Commits`
 * and `Outstanding Context` are per-span facts, so they stay.
 */
export const SLICE_OMITTED_SECTIONS = [
  "Session Goal",
  "User Preferences",
] as const

/**
 * Drop whole-section blocks from a compiled summary.
 *
 * The sections are joined by a blank line *inside* one block, and only the
 * brief transcript is set off by `---`. Splitting on `---` therefore produced a
 * single block whose leading header decided the fate of every section after it
 * — dropping `Session Goal` silently discarded `Files And Changes` too, which
 * is the section a reader most needs. Split on the known headers instead, so a
 * section is removed on its own account and nothing travels with it.
 */
const omitSections = (summary: string, omitted: readonly string[]): string => {
  const kept: string[] = []
  for (const block of summary.split(/\n\n(?=\[(?:Session Goal|Files And Changes|Commits|Outstanding Context|User Preferences)\]\n)/)) {
    const header = /^\[([^\]]+)\]/.exec(block)?.[1]
    if (header !== undefined && omitted.includes(header)) continue
    kept.push(block)
  }
  return kept.join("\n\n")
}

/**
 * Remove refs a merged previous summary carries for messages outside the span
 * being summarized.
 *
 * A slice that contains an earlier summary inherits its `(#N)` refs verbatim,
 * and those point at messages the *previous* compaction covered — which on a
 * partial compaction sit on the side being kept, or before it. They resolve
 * (the index is session-global), so nothing errors; the reader is simply sent
 * outside what this summary claims to describe. Refs that do land inside the
 * span are kept, since those are the useful ones.
 */
export const stripRefsOutside = (text: string, insideSlice: Set<number>): string =>
  // Refs come both singly `(#5)` and grouped `(#13, #14)`, so the whole group
  // has to be matched and then filtered member by member — matching `(#N)`
  // alone silently passes grouped refs through untouched.
  text.replace(/\((#\d+(?:,\s*#\d+)*)\)/g, (_match, group: string) => {
    const kept = group
      .split(/,\s*/)
      .filter((ref) => insideSlice.has(Number(ref.slice(1))))
    return kept.length > 0 ? `(${kept.join(', ')})` : ''
  })

/**
 * Append where the span ended, quoted from its own last assistant text.
 *
 * The brief is a chronological list of tool calls, so nothing in it says
 * whether the work concluded, was abandoned, or is still mid-step — a reader
 * has to infer it, and a reviewer reading these summaries reported inferring
 * it wrongly in half the cases. The span's final assistant words are the one
 * deterministic signal for that, and quoting them verbatim cannot invent
 * anything: the text is in the span by definition.
 */
export const appendEndState = (summary: string, messages: CcMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = (messages[i] as any).message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text as string)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length < 40) continue
    const quoted = text.length > 400 ? `${text.slice(0, 400)}…` : text
    // Already carried by the brief: appending would duplicate rather than inform.
    if (summary.includes(quoted.slice(0, 80))) return summary
    // Re-wrapped like the rest of the summary: this text is appended after the
    // compiler formatted everything, so without this it would be the one line
    // in the output longer than the renderer's safe width.
    const closing = wrapLongLines(`[Where This Span Ended]\n- ${quoted}`)
      .split('\n')
      // A quoted span can contain a path or hash with no break opportunity, so
      // wrapping alone does not guarantee the renderer's safe width.
      .map((line) => (line.length > 120 ? `${line.slice(0, 117)}…` : line))
      .join('\n')
    return `${summary}\n\n${closing}`
  }
  return summary
}

export interface VccSliceCompactionInput {
  /**
   * Exactly the messages to summarize. Unlike `runVccCompaction` this cuts no
   * keep-tail: a partial compaction is *defined* by the caller's pivot, so the
   * caller keeps the other side verbatim and a tail kept here would keep part
   * of the summarized side a second time.
   */
  messages: CcMessage[]
  /** Session-global uuid → `#N`, so refs still resolve after the pivot. */
  globalIndexByUuid?: Map<string, number>
  preCompactTokenCount?: number
  /** Sections to suppress; defaults to `SLICE_OMITTED_SECTIONS`. */
  omitSections?: readonly string[]
}

/**
 * Compile a structured summary of one side of a pivot, with no LLM call.
 *
 * The whole-window entry point cannot express this: it resolves its own cut,
 * while a partial compaction's boundary is chosen by whoever picked the
 * message. So this adapts the given span and compiles it directly — which is
 * also why the output describes only that span, and why the section policy
 * above exists.
 */
export const runVccSliceCompaction = (
  input: VccSliceCompactionInput,
): VccCompactionOutput => {
  const { messages } = input
  const globalIndexByUuid =
    input.globalIndexByUuid ?? buildIndexFromMessages(messages)

  const adapted = adaptCcMessages(messages, globalIndexByUuid)
  const calibration = calibrateFromWindow(
    adapted.messages,
    input.preCompactTokenCount,
  )

  // Indices this span actually covers, so an inherited summary cannot send a
  // reader to the kept side (see stripRefsOutside).
  const insideSlice = new Set<number>()
  for (const m of messages) {
    const uuid = (m as any).uuid
    if (typeof uuid === 'string') {
      const index = globalIndexByUuid.get(uuid)
      if (index !== undefined) insideSlice.add(index)
    }
  }

  const inherited = extractPreviousSummary(messages)
  const previousSummary =
    inherited === undefined ? undefined : stripRefsOutside(inherited, insideSlice)

  const compiled = compileRanked({
    messages: adapted.messages,
    sourceIndices: adapted.sourceIndices,
    previousSummary,
    fileOps: adapted.fileOps,
    ranking: rankingFor(adapted.fileOps, calibration.charsPerToken),
  })

  const summary = appendEndState(
    omitSections(compiled, input.omitSections ?? SLICE_OMITTED_SECTIONS),
    messages,
  )

  return {
    summary,
    messagesToKeep: [],
    keptUserTurns: 0,
    totalUserTurns: adapted.messages.length,
    budgetCut: "none",
    sourceMessageCount: adapted.messages.length,
    previousSummaryUsed: previousSummary != null,
    sections: sectionsOf(summary),
  }
}
