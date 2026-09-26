/**
 * Real-time decode-speed (TPS) meter.
 *
 * Reports output tokens/second for a session's live stream. Three accounting
 * tiers, picked adaptively so the reading tracks real tokens on any provider:
 *
 *  1. `ids`   — the sidecar relayed the engine's real per-chunk token ids
 *               (`tps_tokens`); the window sums those counts exactly.
 *  2. `chunk` — no ids, so each streamed frame counts as one unit. The engine's
 *               average tokens-per-frame (1 for a per-token stream, 3-5 when it
 *               batches or speculates) is learned as `kChunk`.
 *  3. `char`  — a whole-block delivery (a replayed `thinking` block, a
 *               non-streamed answer) has no frame structure to count, so its
 *               text is weighted by the char heuristic (`estimateTokens`),
 *               scaled by the learned `kChar`.
 *
 * `chunk` and `char` are both accumulated and blended with a weight that
 * favours whichever has been predicting the real totals better; their error
 * sources are different (batch-size distribution vs CJK/ASCII mix), so
 * combining them damps both. Their coefficients are re-learned from the real
 * `usage.output_tokens` the CLI reports when each API call completes, so a
 * fixed 3-tokens-per-chunk stream lands on exactly the right rate and a stream
 * whose batch size varies still reads right on average.
 *
 * Window smoothing adapts to any emission granularity. Session lifecycle:
 *  - hasStreamed() is true once any chunk arrived; the UI stays visible.
 *  - While decoding, value() returns the live window speed.
 *  - When decoding pauses / a turn ends, value() falls back to the held speed —
 *    anchored to the real `output_tokens / decode span` when endCall() saw one,
 *    so the number the user keeps seeing is a real-token rate.
 *
 * Char→token heuristic calibrated for the local vLLM engines (Qwen / DeepSeek
 * tokenizers): CJK chars and full-width punctuation ≈ 1 token each, ASCII ≈ 1
 * token per 3.5 chars. Whitespace is not counted — tokenizers fold it into
 * neighbouring tokens, so counting it inflates the estimate.
 */

const WINDOW_MS = 1500
// Held value = average speed over the 0.5s immediately before the stream's last
// emitted chunk, i.e. the speed at which the turn ended.
const FALLBACK_WINDOW_MS = 500
// Denominator floor for the live-window speed (ms). Mobile ws/event loops can
// batch many content_delta chunks so the intra-window span collapses to near-zero
// and total/span would read in the hundreds/thousands. A small floor (NOT the full
// 1.5s window) keeps that burst suppression while letting a turn's *opening* read
// the real speed quickly — the old 1.5s floor spread a fresh turn's first seconds
// across the whole window and systematically under-read the start. The UI's 30/70
// exponential smoothing then damps any residual spike from a genuine batch.
const BURST_FLOOR_MS = 400
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/
const WHITESPACE_RE = /\s/
const NON_CJK_TOKEN_WEIGHT = 1 / 3.5
// A live-window speed below this many tokens/second is treated as a stream
// boundary (text ↔ thinking ↔ tool-input switch), not real slow decoding: the
// just-flushed window holds only a couple of sparse samples whose rate would
// otherwise collapse toward 0. We hold the smoothed fallback instead.
const SPARSE_SPEED_THRESHOLD = 5
// Tail skip when computing the held average. 0: the user wants the speed over
// the 0.5s slice *immediately before* the last chunk, including the final
// moments — so nothing is skipped.
const FALLBACK_SKIP_MS = 0

// ── Real-token calibration ────────────────────────────────────────────────
/**
 * Learned tokens-per-unit multiplier is clamped to this range. The ceiling
 * leaves room for engines that batch or speculate (several tokens per frame)
 * while still bounding the damage a bogus sample could do.
 */
const K_MIN = 0.25
const K_MAX = 8
/** A call below this many real output tokens is too small to teach anything. */
const MIN_REAL_TOKENS_TO_LEARN = 50
/** Nor may a call settle a coefficient from only a handful of units. */
const MIN_UNITS_TO_LEARN = 5
/** Blend weight for the frame-count estimator until the errors are measured. */
const DEFAULT_CHUNK_WEIGHT = 0.7
const CHUNK_WEIGHT_MIN = 0.2
const CHUNK_WEIGHT_MAX = 0.8
/** A call whose unit count dwarfs the running mean is a replay, not a real burst. */
const OUTLIER_UNIT_FACTOR = 3
const K_EWMA_ALPHA = 0.3
const ERROR_EWMA_ALPHA = 0.25
const UNIT_MEAN_EWMA_ALPHA = 0.25

/**
 * Master switch for the TPS indicator. Set to false to disable the meter
 * (no sampling in the content_delta path and no UI) while keeping the code in
 * place — used to isolate whether the indicator interacts with tool calls.
 */
const TPS_ENABLED = true

export function isTpsEnabled(): boolean {
  return TPS_ENABLED
}

/** Which accounting tier the current window is reading from. */
export type TpsSource = 'ids' | 'chunk' | 'char'

/** Learned tokens-per-unit coefficients for one model. */
export type TpsCalibration = { kChunk: number; kChar: number }

type Sample = { t: number; chunk: number; char: number; ids: number }

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function ewma(previous: number | null, next: number, alpha: number): number {
  return previous === null ? next : previous + alpha * (next - previous)
}

export class TpsMeter {
  private samples: Sample[] = []
  private windowMs: number
  private fallbackWindowMs: number
  private everStreamed = false
  private lastPushAt = 0
  private fallbackTps = 0

  // Calibration learned from real usage (survives reset(); it describes the
  // model, not this window).
  private kChunk = 1
  private kChar = 1
  private kChunkCount = 0
  private kCharCount = 0
  private errChunk: number | null = null
  private errChar: number | null = null
  private unitMean: number | null = null

  // Units observed since beginCall(); reconciled against real tokens in endCall().
  private callOpen = false
  private callChunk = 0
  private callChar = 0
  private callIds = 0
  private callFirstAt = 0
  private callLastAt = 0

  constructor(windowMs = WINDOW_MS, fallbackWindowMs = FALLBACK_WINDOW_MS) {
    this.windowMs = windowMs
    this.fallbackWindowMs = fallbackWindowMs
  }

  /**
   * Feed a streamed text chunk.
   *
   * `wholeBlock` marks a delivery that carries a finished block rather than a
   * fragment (a replayed `thinking` block, a non-streamed answer): it has no
   * frame to count, so it is weighted by its text instead.
   */
  push(text: string, options: { wholeBlock?: boolean; external?: boolean } = {}): void {
    const now = performance.now()
    this.lastPushAt = now
    this.everStreamed = true
    const external = options.external === true
    const chunkUnits = options.wholeBlock === true ? 0 : 1
    const charUnits = text ? estimateTokens(text) : 0
    if (chunkUnits === 0 && charUnits === 0) {
      if (!external) this.noteCallFrame(now)
      return
    }
    this.samples.push({ t: now, chunk: chunkUnits, char: charUnits, ids: 0 })
    if (!external) this.noteCallFrame(now, chunkUnits, charUnits)
    this.fallbackTps = this.computeFallbackTps(now)
  }

  /**
   * Feed a real token count relayed by the sidecar (the engine's per-chunk
   * `token_ids`). These are exact, so they bypass calibration entirely.
   */
  pushTokens(tokens: number): void {
    const count = Math.floor(tokens)
    if (!Number.isFinite(count) || count <= 0) return
    const now = performance.now()
    this.samples.push({ t: now, chunk: 0, char: 0, ids: count })
    this.lastPushAt = now
    this.everStreamed = true
    this.noteCallFrame(now, 0, 0, count)
    this.fallbackTps = this.computeFallbackTps(now)
  }

  /** Bump liveness without recording units (a frame the exact source already covers). */
  touch(): void {
    this.lastPushAt = performance.now()
    this.everStreamed = true
  }

  /** True once this session has ever received streamed text. */
  hasStreamed(): boolean {
    return this.everStreamed
  }

  /**
   * True while the sliding window still holds fresh samples — i.e. this
   * stream is actively emitting right now. Once the window drains, a
   * finished session's held turn-ending speed must not keep feeding the
   * aggregate (see aggregateMeterReadings).
   */
  hasLiveSamples(): boolean {
    this.prune()
    return this.samples.length > 0
  }

  /** Epoch ms of the most recent streamed chunk (0 if never). */
  lastDataTime(): number {
    return this.lastPushAt
  }

  /** Which tier the current window is reading from (for UI/diagnostics). */
  source(): TpsSource {
    this.prune()
    let ids = 0
    let chunk = 0
    for (const sample of this.samples) {
      ids += sample.ids
      chunk += sample.chunk
    }
    if (ids > 0) return 'ids'
    return chunk > 0 ? 'chunk' : 'char'
  }

  /** Learned coefficients, for persistence per model (see tpsCalibration). */
  calibration(): TpsCalibration {
    return { kChunk: this.kChunk, kChar: this.kChar }
  }

  /**
   * Seed coefficients learned from earlier sessions with the same model.
   *
   * `undefined` leaves the current coefficients alone; `null` means "this model
   * has nothing remembered" and resets to the neutral 1.0 (so a model switch
   * re-learns instead of inheriting the previous model's numbers).
   */
  setCalibration(calibration: TpsCalibration | null | undefined): void {
    if (calibration === undefined) return
    if (calibration === null) {
      this.kChunk = 1
      this.kChar = 1
      this.kChunkCount = 0
      this.kCharCount = 0
      this.errChunk = null
      this.errChar = null
      this.unitMean = null
      return
    }
    const { kChunk, kChar } = calibration
    if (Number.isFinite(kChunk) && kChunk > 0) {
      this.kChunk = clamp(kChunk, K_MIN, K_MAX)
      // Mark as learned so a stored value is not immediately averaged away.
      this.kChunkCount = Math.max(this.kChunkCount, 2)
    }
    if (Number.isFinite(kChar) && kChar > 0) {
      this.kChar = clamp(kChar, K_MIN, K_MAX)
      this.kCharCount = Math.max(this.kCharCount, 2)
    }
  }

  /** Open a reconciliation window for one API call. */
  beginCall(): void {
    this.callOpen = true
    this.callChunk = 0
    this.callChar = 0
    this.callIds = 0
    this.callFirstAt = 0
    this.callLastAt = 0
  }

  /** Open a call window unless one is already open (idempotent per frame). */
  ensureCall(): void {
    if (!this.callOpen) this.beginCall()
  }

  /**
   * Close the call opened by beginCall() and reconcile the sampled units with
   * the real output token count the CLI reported.
   *
   * Always anchors the held speed to the real rate when a decode span can be
   * measured; learns the per-unit coefficients only when the call carried no
   * exact ids (those need no calibration) and the sample is big enough to
   * trust.
   *
   * @param decodeSpanMs real decode span when the CLI reported one, else the
   *        caller's observed span (first→last frame of the call).
   * @returns whether a coefficient was actually updated (so callers know
   *          whether there is anything new worth persisting).
   */
  endCall(realTokens: number, decodeSpanMs?: number): boolean {
    const callChunk = this.callChunk
    const callChar = this.callChar
    const callIds = this.callIds
    const firstAt = this.callFirstAt
    const lastAt = this.callLastAt
    this.callOpen = false
    this.callChunk = 0
    this.callChar = 0
    this.callIds = 0
    this.callFirstAt = 0
    this.callLastAt = 0

    const real = Math.floor(realTokens)
    if (!Number.isFinite(real) || real <= 0) return false

    const spanMs = decodeSpanMs && decodeSpanMs > 0
      ? decodeSpanMs
      : (firstAt > 0 && lastAt > firstAt ? lastAt - firstAt : 0)
    if (spanMs > 0) this.fallbackTps = real / (spanMs / 1000)

    if (callIds > 0) return false
    const units = callChunk + callChar
    if (units <= 0) return false
    // A fallback/retry replays the prefix, inflating units without inflating
    // real tokens. Drop the sample instead of teaching the coefficients a lie.
    if (this.unitMean !== null && units > OUTLIER_UNIT_FACTOR * this.unitMean) return false
    this.unitMean = ewma(this.unitMean, units, UNIT_MEAN_EWMA_ALPHA)
    if (real < MIN_REAL_TOKENS_TO_LEARN) return false

    // Coordinate descent on the blend: solve one coefficient with the other
    // held fixed, then re-solve the second against the first's new value — so
    // the blend ends up summing to the real token count for this call.
    const weight = this.blendWeightFor(callChunk, callChar)
    const chunkUnits = weight * callChunk
    const charUnits = (1 - weight) * callChar
    let learned = false

    if (chunkUnits > 0 && callChunk >= MIN_UNITS_TO_LEARN) {
      const kCall = (real - charUnits * this.kChar) / chunkUnits
      if (kCall > 0) {
        this.kChunk = clamp(
          this.kChunkCount === 0 ? kCall : ewma(this.kChunk, kCall, K_EWMA_ALPHA),
          K_MIN,
          K_MAX,
        )
        this.kChunkCount += 1
        learned = true
      }
    }
    const settledChunkPart = chunkUnits * this.kChunk
    if (charUnits > 0 && callChar >= MIN_UNITS_TO_LEARN) {
      const kCall = (real - settledChunkPart) / charUnits
      if (kCall > 0) {
        this.kChar = clamp(
          this.kCharCount === 0 ? kCall : ewma(this.kChar, kCall, K_EWMA_ALPHA),
          K_MIN,
          K_MAX,
        )
        this.kCharCount += 1
        learned = true
      }
    }

    // Compare the two estimators as full-total predictions (each scaled out of
    // its blend share), so the weight reflects which one tracks reality better.
    const settledCharPart = charUnits * this.kChar
    if (chunkUnits > 0) {
      this.errChunk = ewma(this.errChunk, Math.abs(settledChunkPart / weight - real) / real, ERROR_EWMA_ALPHA)
    }
    if (charUnits > 0) {
      this.errChar = ewma(this.errChar, Math.abs(settledCharPart / (1 - weight) - real) / real, ERROR_EWMA_ALPHA)
    }
    return learned
  }

  /**
   * Tokens/second within the sliding window. While decoding steadily this is
   * the live window speed; when the engine pauses or switches streams
   * (text → thinking → tool input) the just-flushed window can hold only a
   * couple of sparse samples whose instantaneous rate would collapse toward 0.
   * In that case fall back to the held speed so the indicator holds a sensible
   * value instead of flashing 0 between turns.
   */
  value(): number {
    this.prune()
    if (this.samples.length === 0) return this.fallbackTps
    const total = this.windowTokens()
    const first = this.samples[0]!
    const last = this.samples[this.samples.length - 1]!
    const span = (last.t - first.t) / 1000
    // Burst guard (opt23 §11.27): on mobile a batched ws delivery can collapse the
    // intra-window span to near-zero, so a small floor (BURST_FLOOR_MS) prevents
    // total/span from reading in the hundreds. Using the full window here instead
    // would also under-read a turn's opening — see BURST_FLOOR_MS.
    const elapsed = Math.max(span, BURST_FLOOR_MS / 1000)
    const result = total / elapsed
    // Boundary guard: a window whose live speed is below the sparse threshold
    // is a stream switch, not slow decoding — hold the smoothed fallback and
    // do NOT let the sparse rate overwrite it.
    if (result < SPARSE_SPEED_THRESHOLD) return this.fallbackTps
    // The held (fallback) value is owned exclusively by push()/endCall(): it is
    // the real rate, or the average over the 0.5s before the last emitted chunk.
    // Refreshing it here would let the shrinking, span-floored tail window
    // overwrite the requested turn-ending speed while the live window drains.
    return result
  }

  reset(): void {
    this.samples = []
    this.everStreamed = false
    this.lastPushAt = 0
    this.fallbackTps = 0
    this.callOpen = false
    this.callChunk = 0
    this.callChar = 0
    this.callIds = 0
    this.callFirstAt = 0
    this.callLastAt = 0
  }

  /** Calibrated token total held in the window (diagnostics/tests). */
  windowTokens(): number {
    this.prune()
    let ids = 0
    let chunk = 0
    let char = 0
    for (const sample of this.samples) {
      ids += sample.ids
      chunk += sample.chunk
      char += sample.char
    }
    if (ids > 0 && chunk === 0 && char === 0) return ids
    const weight = this.blendWeightFor(chunk, char)
    return ids + weight * chunk * this.kChunk + (1 - weight) * char * this.kChar
  }

  /**
   * Weight for the chunk estimator. A window that only saw one kind of unit
   * takes that estimator alone; when both are present, prefer whichever has
   * been tracking the real totals better.
   */
  private blendWeightFor(hasChunk: number, hasChar: number): number {
    if (hasChunk <= 0) return 0
    if (hasChar <= 0) return 1
    if (this.errChunk !== null && this.errChar !== null) {
      const total = this.errChunk + this.errChar
      if (total > 0) return clamp(this.errChar / total, CHUNK_WEIGHT_MIN, CHUNK_WEIGHT_MAX)
    }
    // Nothing measured yet: chunk-primary, with the text estimator keeping a
    // minority share so it can be learned from the same calls.
    return DEFAULT_CHUNK_WEIGHT
  }

  private noteCallFrame(now: number, chunk = 0, char = 0, ids = 0): void {
    if (!this.callOpen) return
    if (this.callFirstAt === 0) this.callFirstAt = now
    this.callLastAt = now
    this.callChunk += chunk
    this.callChar += char
    this.callIds += ids
  }

  private computeFallbackTps(now: number): number {
    // Average token rate over the last fallbackWindowMs (0.5s) of streamed
    // data — the speed at which the turn ended. FALLBACK_SKIP_MS trims the
    // newest slice (0 by default).
    const windowEnd = now - FALLBACK_SKIP_MS
    const windowStart = windowEnd - this.fallbackWindowMs
    let total = 0
    let firstT: number | null = null
    let lastT: number | null = null
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i]!
      if (s.t < windowStart) break
      if (s.t > windowEnd) continue
      total += this.sampleTokens(s)
      if (lastT === null) lastT = s.t
      firstT = s.t
    }
    if (firstT === null || lastT === null) return 0
    const span = (lastT - firstT) / 1000
    if (span < 0.05) return total / (this.fallbackWindowMs / 1000)
    return total / span
  }

  private sampleTokens(sample: Sample): number {
    if (sample.ids > 0) return sample.ids
    const weight = this.blendWeightFor(sample.chunk, sample.char)
    return weight * sample.chunk * this.kChunk + (1 - weight) * sample.char * this.kChar
  }

  private prune(): void {
    const cutoff = performance.now() - this.windowMs
    while (this.samples.length > 0 && this.samples[0]!.t < cutoff) {
      this.samples.shift()
    }
  }
}

/**
 * Aggregate reading for a session's TPS indicator. `tps` is the team-wide
 * decode speed; `activeSubs` is the count of subagents currently emitting.
 */
export type TpsAggregate = {
  visible: boolean
  tps: number
  /** Subagent meters with fresh samples in the window (emitting right now). */
  activeSubs: number
}

/**
 * Build the session's reading from its own meter, using the subordinate
 * (subagent/team-member) meters only to count who is emitting right now.
 *
 *  - `own` already carries every subagent's relayed decode text (chatStore
 *    folds it in per frame, see ingestSubagentTps), so the summed value is
 *    just `own.value()`. The subordinate meters must NOT be added on top: they
 *    hold the same tokens and would double the reported rate.
 *  - While nothing is decoding the reading falls back to the own session's
 *    held speed — identical to the pre-aggregation single-session behavior,
 *    so a lone main session is unaffected.
 *  - Visibility / the 5-min idle hide rule considers the newest data from
 *    the whole group, so a busy subagent keeps the main indicator alive.
 */
export function aggregateMeterReadings(
  own: TpsMeter,
  subordinates: TpsMeter[],
  now: number,
  hideAfterIdleMs: number,
): TpsAggregate {
  const everStreamed = own.hasStreamed() || subordinates.some((m) => m.hasStreamed())
  if (!everStreamed) return { visible: false, tps: 0, activeSubs: 0 }

  let lastData = own.lastDataTime()
  for (const m of subordinates) {
    if (m.lastDataTime() > lastData) lastData = m.lastDataTime()
  }
  if (lastData > 0 && now - lastData > hideAfterIdleMs) {
    return { visible: false, tps: 0, activeSubs: 0 }
  }

  if (!own.hasStreamed()) {
    // Only a subordinate ever streamed: nothing is folded into the displayed
    // meter, so there is no honest rate to show yet.
    return { visible: false, tps: 0, activeSubs: 0 }
  }
  const activeSubs = subordinates.filter((m) => m.hasLiveSamples()).length
  return { visible: true, tps: own.value(), activeSubs }
}

export function estimateTokens(text: string): number {
  let cjk = 0
  let nonCjk = 0
  for (const ch of text) {
    if (WHITESPACE_RE.test(ch)) continue
    if (CJK_RE.test(ch)) cjk += 1
    else nonCjk += 1
  }
  return cjk + nonCjk * NON_CJK_TOKEN_WEIGHT
}
