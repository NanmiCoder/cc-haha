// Tail-keep cut for VCC compaction, adapted from pi-vcc's before-compact hook
// (buildOwnCut / applyTailBudget / resolveSmartKeepUserTurns, 0.8.0).
//
// pi-vcc operates on pi session entries (with nested compaction records);
// cc-haha hands us the in-memory window already projected past the last
// compact boundary (getMessagesAfterCompactBoundary), so the cut is applied
// directly on the adapted PiMessage[] array.
//
// The cut is found in pi-message space (user-turn anchoring / token budget)
// but expressed as a cc-message anchor (`keptCcStart`) so CompactionResult
// can keep a contiguous run of whole cc messages — a single cc message that
// emitted several pi messages (e.g. Bash execution + tool results) is never
// split across the boundary.
//
// Semantics preserved:
//  - keep:N user-turns at the tail are kept verbatim (passed back as
//    messagesToKeep through CompactionResult);
//  - smart keep: when the keep:1 tail is small (<= MIN tokens), grow keep to
//    the largest N whose tail stays <= MAX tokens;
//  - oversized tail (> MAX * factor) is re-cut on a token budget at the
//    nearest non-toolResult boundary;
//  - no usable boundary (single user prompt, etc.) → compact everything.
import type { Message } from "./pi-ai"
import {
  estimateMessageContentTokens,
  estimateTokensFromChars,
  calibrateCharsPerToken,
  estimateMessageContentChars,
  type TokenEstimateCalibration,
} from "./vendor/core/token-estimate"

export const MIN_SMART_TAIL_TOKENS = 5_000
export const MAX_SMART_TAIL_TOKENS = 25_000
export const OVERSIZED_TAIL_FACTOR = 2.5

export interface VccCutResult {
  ok: boolean
  /** Pi messages to summarize (everything before the kept tail). */
  toSummarize: Message[]
  /** Global `#N` indices parallel to `toSummarize`. */
  toSummarizeIndices: Array<number | undefined>
  /** cc-message index where the kept tail begins; `ccMessages.slice(keptCcStart)`
   *   is the messagesToKeep. Equals `ccMessages.length` when compacting all. */
  keptCcStart: number
  keptUserTurns: number
  totalUserTurns: number
  keepFallbackToCompactAll: boolean
  budgetCut: "none" | "no_anchor" | "oversized_tail"
}

interface CutCore {
  cutPi: number
  keptUserTurns: number
  keepFallbackToCompactAll: boolean
  budgetCut: VccCutResult["budgetCut"]
}

const userTurnsOf = (messages: Message[]): number[] =>
  messages.reduce<number[]>((acc, m, i) => {
    if (m.role === "user") acc.push(i)
    return acc
  }, [])

/**
 * Split the window into (toSummarize, toKeep). `keepUserTurns` is the
 * smart-keep resolved value; the tail budget re-cut may lower the effective
 * kept region when the tail is oversized.
 */
export const buildVccCut = (
  messages: Message[],
  sourceIndices: Array<number | undefined>,
  ccIndices: number[],
  keepUserTurns: number,
  opts: { charsPerToken?: number } = {},
): VccCutResult => {
  const totalUserTurns = userTurnsOf(messages).length
  const finish = (core: CutCore): VccCutResult => {
    const keptCcStart =
      core.cutPi >= messages.length
        ? ccIndices[ccIndices.length - 1] + 1 // compact-all: nothing kept
        : ccIndices[core.cutPi]
    return {
      ok: true,
      toSummarize: messages.slice(0, core.cutPi),
      toSummarizeIndices: sourceIndices.slice(0, core.cutPi),
      keptCcStart,
      keptUserTurns: core.keptUserTurns,
      totalUserTurns,
      keepFallbackToCompactAll: core.keepFallbackToCompactAll,
      budgetCut: core.budgetCut,
    }
  }

  if (messages.length === 0)
    return {
      ok: false,
      toSummarize: [],
      toSummarizeIndices: [],
      keptCcStart: 0,
      keptUserTurns: 0,
      totalUserTurns: 0,
      keepFallbackToCompactAll: false,
      budgetCut: "none",
    }
  if (messages.length <= 2)
    return finish({ cutPi: messages.length, keptUserTurns: 0, keepFallbackToCompactAll: true, budgetCut: "none" })

  const userIndices = userTurnsOf(messages)
  if (keepUserTurns <= 0)
    return finish({ cutPi: messages.length, keptUserTurns: 0, keepFallbackToCompactAll: false, budgetCut: "none" })

  const target = userIndices.length - keepUserTurns
  const cutIdx = target >= 0 ? userIndices[target] : -1
  if (cutIdx <= 0)
    // Single user prompt (or keep larger than available turns): no safe
    // boundary, summarize everything (mirrors pi-vcc's compact-all fallback).
    return finish({ cutPi: messages.length, keptUserTurns: 0, keepFallbackToCompactAll: true, budgetCut: "none" })

  const cpt = opts.charsPerToken
  let tailTokens = 0
  for (let i = cutIdx; i < messages.length; i++)
    tailTokens += estimateMessageContentTokens(messages[i].content, cpt)

  // Token-budget tail re-cut: only fires when the kept tail exceeds
  // MAX * OVERSIZED_TAIL_FACTOR (mirrors pi-vcc's applyTailBudget case B).
  if (tailTokens > MAX_SMART_TAIL_TOKENS * OVERSIZED_TAIL_FACTOR) {
    let acc = 0
    let crossed = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      acc += estimateMessageContentTokens(messages[i].content, cpt)
      if (acc >= MAX_SMART_TAIL_TOKENS) {
        crossed = i
        break
      }
    }
    if (crossed > 0) {
      // Snap forward off any toolResult to the next valid boundary.
      let idx = crossed
      for (let j = Math.max(crossed, 1); j < messages.length; j++) {
        if (messages[j].role !== "toolResult") {
          idx = j
          break
        }
      }
      if (idx > cutIdx)
        return finish({
          cutPi: idx,
          keptUserTurns: messages.slice(idx).filter((m) => m.role === "user").length,
          keepFallbackToCompactAll: false,
          budgetCut: "oversized_tail",
        })
    }
  }

  return finish({
    cutPi: cutIdx,
    keptUserTurns: userIndices.length - target,
    keepFallbackToCompactAll: false,
    budgetCut: "none",
  })
}

const tailTokensForKeep = (
  messages: Message[],
  userIndices: number[],
  keepUserTurns: number,
  charsPerToken?: number,
): number | null => {
  const target = userIndices.length - keepUserTurns
  const cutIdx = target >= 0 ? userIndices[target] : -1
  if (cutIdx <= 0) return null
  let chars = 0
  for (let i = cutIdx; i < messages.length; i++)
    chars += estimateMessageContentChars(messages[i].content)
  return estimateTokensFromChars(chars, charsPerToken)
}

/**
 * Smart keep-tail: if the keep:1 tail is <= MIN tokens, grow keep to the
 * largest N whose tail stays <= MAX tokens. Mirrors pi-vcc's
 * resolveSmartKeepUserTurns.
 */
export const resolveSmartKeepUserTurns = (
  messages: Message[],
  calibration: TokenEstimateCalibration,
): { keepUserTurns: number; smartAdjusted: boolean; fromKeep: number } => {
  const userIndices = userTurnsOf(messages)
  const baseKeep = 1
  const cpt = calibration.charsPerToken

  const baseTokens = tailTokensForKeep(messages, userIndices, baseKeep, cpt)
  if (baseTokens == null || baseTokens > MIN_SMART_TAIL_TOKENS)
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep }

  let selected = baseKeep
  for (let k = baseKeep + 1; k <= userIndices.length; k++) {
    const tokens = tailTokensForKeep(messages, userIndices, k, cpt)
    if (tokens == null || tokens > MAX_SMART_TAIL_TOKENS) break
    selected = k
  }
  return {
    keepUserTurns: selected,
    smartAdjusted: selected !== baseKeep,
    fromKeep: baseKeep,
  }
}

/**
 * Calibrate chars/token from the window's pre-compact token count. Uses the
 * same heuristic fallback as pi-vcc when the count is unavailable.
 */
export const calibrateFromWindow = (
  messages: Message[],
  preCompactTokenCount: number | undefined,
): TokenEstimateCalibration => {
  let chars = 0
  for (const m of messages) chars += estimateMessageContentChars(m.content)
  return calibrateCharsPerToken(chars, preCompactTokenCount)
}
