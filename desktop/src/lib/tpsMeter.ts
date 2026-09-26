/**
 * Real-time decode-speed (TPS) meter.
 *
 * Reports output tokens/second for a session's live stream, from whichever
 * signal the backend actually provides:
 *
 *  1. `ids`  — the sidecar relayed the engine's real per-chunk token ids
 *              (`tps_tokens`). Those counts are exact, so they are summed
 *              as-is and every other signal is ignored for that window.
 *  2. `char` — no ids, so the streamed text itself is the measurement: CJK
 *              characters and full-width punctuation weigh one unit each,
 *              other non-whitespace characters a third of a unit, and each
 *              unit's tokens-per-unit is learned per model from the real
 *              `usage.output_tokens` every completed call reports.
 *
 * ## Why the text, and not the number of streamed frames
 *
 * An earlier version counted frames ("each chunk = one unit") and learned an
 * average tokens-per-frame. That is unsound for any engine that batches
 * unevenly, and this one does: measured on the local vLLM+DFlash engine, a
 * frame carrying streamed *text* holds ~2.5 tokens, a frame carrying
 * *thinking* ~12, and a frame carrying a tool-input JSON blob ~90-220. The
 * client also coalesces deltas before the meter sees them, so the observable
 * frame count is partly a property of the client's throttling.
 *
 * One global tokens-per-frame cannot serve densities that differ ~40x, and it
 * fails loudly rather than quietly: a single call whose frames were dense JSON
 * taught the local meter ~51 tokens/frame (clamped to the ceiling of 8), after
 * which six concurrent subagents writing prose — sparse frames, ~2.5 tokens
 * each — were billed at the JSON density and the indicator read ~800 tok/s
 * while the engine log showed ~250. The text length has no such failure mode:
 * it is a direct measure of what was decoded, whatever the batch size, so the
 * frame count is now used only for liveness and for the window's time span.
 *
 * Two coefficients rather than one, because the two character classes really
 * do tokenize at different rates: measured on the same engine, CJK prose is
 * ~1.0 token/char-unit while JSON/code is ~1.9 (short tokens, dense
 * punctuation). Both are learned together (least squares over every completed
 * call's units and its real token count) and stored per model, so mixed
 * Chinese-plus-code traffic stays inside a few tens of percent instead of the
 * factor-of-two a single coefficient would carry between a prose call and a
 * tool-input call.
 *
 * Window smoothing adapts to any emission granularity. Session lifecycle:
 *  - hasStreamed() is true once any content arrived; the UI stays visible.
 *  - While decoding, value() returns the live window speed.
 *  - When decoding pauses / a turn ends, value() falls back to the held speed —
 *    anchored to the real `output_tokens / decode span` when endCall() saw one,
 *    so the number the user keeps seeing is a real-token rate.
 */

const WINDOW_MS = 1500
// Held value = average speed over the 0.5s immediately before the stream's last
// emitted chunk, i.e. the speed at which the turn ended.
const FALLBACK_WINDOW_MS = 500
// Denominator floor for the live-window speed (ms). Mobile ws/event loops can
// batch many deltas so the intra-window span collapses to near-zero and
// total/span would read in the hundreds/thousands. A small floor (NOT the full
// 1.5s window) keeps that burst suppression while letting a turn's *opening*
// read the real speed quickly — the old 1.5s floor spread a fresh turn's first
// seconds across the whole window and systematically under-read the start. The
// UI's 30/70 exponential smoothing then damps any residual spike.
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

// ── Calibration ───────────────────────────────────────────────────────────
/**
 * Bounds for a learned tokens-per-unit coefficient. The band spans the
 * plausible tokenizer densities (a mixed corpus sits near 1.0, dense
 * code/JSON near 2) with room on either side, while still bounding the damage
 * a single weird call could do.
 */
const K_MIN = 0.25
const K_MAX = 6
/** A call below this many real output tokens is too small to teach anything. */
const MIN_REAL_TOKENS_TO_LEARN = 50
/** Nor may a call settle coefficients from only a handful of text units. */
const MIN_UNITS_TO_LEARN = 40
/** A call whose unit count dwarfs the running mean is a replay, not a real burst. */
const OUTLIER_UNIT_FACTOR = 3
const UNIT_MEAN_EWMA_ALPHA = 0.2
/**
 * Forgetting factor on the least-squares accumulators: the engine's density is
 * stable, but a session that switched models (and kept this meter) should not
 * be outvoted forever by its first calls.
 */
const LEARN_FORGET = 0.9
/** Below this relative determinant the two classes are not separable yet. */
const SINGULAR_EPS = 1e-6

/**
 * Master switch for the TPS indicator. Set to false to disable the meter
 * (no sampling in the content_delta path and no UI) while keeping the code in
 * place — used to isolate whether the indicator interacts with tool calls.
 */
const TPS_ENABLED = true

export function isTpsEnabled(): boolean {
  return TPS_ENABLED
}

export type TpsSource = 'ids' | 'char'

/** Learned tokens-per-unit, per character class (see the module docs). */
export type TpsCalibration = { kCjk: number; kAscii: number }

/** Text units split by class, the meter's raw measurement. */
type Sample = {
  t: number
  /** CJK / full-width characters, 1 unit each. */
  cjk: number
  /** Other non-whitespace characters, 1/3.5 unit each. */
  ascii: number
  /** Relayed exact token count (0 for text samples). */
  ids: number
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function textUnits(text: string): { cjk: number; ascii: number } {
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    if (WHITESPACE_RE.test(ch)) continue
    if (CJK_RE.test(ch)) cjk += 1
    else ascii += 1
  }
  return { cjk, ascii: ascii * NON_CJK_TOKEN_WEIGHT }
}

export class TpsMeter {
  private samples: Sample[] = []
  private lastPushAt = 0
  private fallbackTps = 0
  private everStreamed = false
  private readonly windowMs: number
  private readonly fallbackWindowMs: number

  // Learned coefficients and the least-squares accumulators behind them. They
  // describe the model, not this window, so reset() keeps them.
  private kCjk = 1
  private kAscii = 1
  private sCC = 0
  private sAA = 0
  private sCA = 0
  private sCY = 0
  private sAY = 0
  private unitMean: number | null = null

  // Units observed since beginCall(); reconciled against real tokens in endCall().
  private callOpen = false
  private callCjk = 0
  private callAscii = 0
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
   * fragment (a replayed `thinking` block, a non-streamed answer). It is
   * accepted for call-site compatibility but changes nothing: the measurement
   * is the text itself, which a whole block carries just as well as a
   * fragment does.
   */
  push(text: string, options: { wholeBlock?: boolean; external?: boolean } = {}): void {
    const now = performance.now()
    this.lastPushAt = now
    this.everStreamed = true
    const external = options.external === true
    const { cjk, ascii } = text ? textUnits(text) : { cjk: 0, ascii: 0 }
    if (cjk === 0 && ascii === 0) {
      if (!external) this.noteCallFrame(now)
      return
    }
    this.samples.push({ t: now, cjk, ascii, ids: 0 })
    if (!external) this.noteCallFrame(now, cjk, ascii)
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
    this.samples.push({ t: now, cjk: 0, ascii: 0, ids: count })
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

  /** True once this session has ever received streamed content. */
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

  /** Which signal the current window is reading (for UI/diagnostics). */
  source(): TpsSource {
    this.prune()
    for (const sample of this.samples) {
      if (sample.ids > 0) return 'ids'
    }
    return 'char'
  }

  /** Learned coefficients, for persistence per model (see tpsCalibration). */
  calibration(): TpsCalibration {
    return { kCjk: this.kCjk, kAscii: this.kAscii }
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
      this.kCjk = 1
      this.kAscii = 1
      this.sCC = 0
      this.sAA = 0
      this.sCA = 0
      this.sCY = 0
      this.sAY = 0
      this.unitMean = null
      return
    }
    const { kCjk, kAscii } = calibration
    if (Number.isFinite(kCjk) && kCjk > 0) this.kCjk = clamp(kCjk, K_MIN, K_MAX)
    if (Number.isFinite(kAscii) && kAscii > 0) this.kAscii = clamp(kAscii, K_MIN, K_MAX)
  }

  /** Open a reconciliation window for one API call. */
  beginCall(): void {
    this.callOpen = true
    this.callCjk = 0
    this.callAscii = 0
    this.callIds = 0
    this.callFirstAt = 0
    this.callLastAt = 0
  }

  /** Open a call window unless one is already open (idempotent per frame). */
  ensureCall(): void {
    if (!this.callOpen) this.beginCall()
  }

  /**
   * Close the call opened by beginCall() and reconcile the measured text with
   * the real output token count the CLI reported.
   *
   * Always anchors the held speed to the real rate when a decode span can be
   * measured; learns the coefficients only when the call carried no exact ids
   * (those need no calibration) and the sample is big enough to trust.
   *
   * @param decodeSpanMs real decode span when the CLI reported one, else the
   *        caller's observed span (first→last frame of the call).
   * @returns whether a coefficient was actually updated (so callers know
   *          whether there is anything new worth persisting).
   */
  endCall(realTokens: number, decodeSpanMs?: number): boolean {
    const callCjk = this.callCjk
    const callAscii = this.callAscii
    const callIds = this.callIds
    const firstAt = this.callFirstAt
    const lastAt = this.callLastAt
    this.callOpen = false
    this.callCjk = 0
    this.callAscii = 0
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
    const units = callCjk + callAscii
    if (units < MIN_UNITS_TO_LEARN) return false
    // A fallback/retry replays the prefix, inflating units without inflating
    // real tokens. Drop the sample instead of teaching the coefficients a lie.
    if (this.unitMean !== null && units > OUTLIER_UNIT_FACTOR * this.unitMean) return false
    if (real < MIN_REAL_TOKENS_TO_LEARN) return false
    this.unitMean = this.unitMean === null
      ? units
      : this.unitMean + UNIT_MEAN_EWMA_ALPHA * (units - this.unitMean)

    return this.learn(callCjk, callAscii, real)
  }

  /**
   * Fold one call's (class units, real tokens) into the two coefficients by
   * least squares, so the estimator sums to the real count for the calls seen
   * so far rather than to whichever single call came last.
   *
   * Two unknowns need more than one equation: the accumulators keep the normal
   * equations of every past call, which is what lets a prose-heavy call and a
   * JSON-heavy call separate the classes. Until both classes have actually
   * appeared the system is singular, and the class that did appear is fitted on
   * its own.
   */
  private learn(cjk: number, ascii: number, real: number): boolean {
    const f = LEARN_FORGET
    this.sCC = f * this.sCC + cjk * cjk
    this.sAA = f * this.sAA + ascii * ascii
    this.sCA = f * this.sCA + cjk * ascii
    this.sCY = f * this.sCY + cjk * real
    this.sAY = f * this.sAY + ascii * real

    const det = this.sCC * this.sAA - this.sCA * this.sCA
    const scale = this.sCC * this.sAA
    if (scale > 0 && det > SINGULAR_EPS * scale) {
      const kCjk = (this.sCY * this.sAA - this.sAY * this.sCA) / det
      const kAscii = (this.sAY * this.sCC - this.sCY * this.sCA) / det
      let learned = false
      if (kCjk > 0) { this.kCjk = clamp(kCjk, K_MIN, K_MAX); learned = true }
      if (kAscii > 0) { this.kAscii = clamp(kAscii, K_MIN, K_MAX); learned = true }
      return learned
    }
    // Not separable yet — only one class has appeared, or every call so far
    // mixed them in the same proportion. Fit the single coefficient the data
    // does support (kCjk = kAscii = k, whose least-squares solution is the sum
    // over both classes) so the estimator is not stuck at the neutral 1.0
    // until the mixes happen to diverge.
    const denom = this.sCC + this.sAA + 2 * this.sCA
    if (denom <= 0) return false
    const k = (this.sCY + this.sAY) / denom
    if (!(k > 0)) return false
    const settled = clamp(k, K_MIN, K_MAX)
    // Only classes that actually appeared may be written: a call of pure
    // latin tool-input says nothing about what a CJK character costs, and
    // letting it set that coefficient would bill the next Chinese reply at
    // code density until some later call happened to correct it.
    let learned = false
    if (this.sCC > 0) { this.kCjk = settled; learned = true }
    if (this.sAA > 0) { this.kAscii = settled; learned = true }
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
    // Burst guard: on mobile a batched ws delivery can collapse the
    // intra-window span to near-zero, so a small floor (BURST_FLOOR_MS)
    // prevents total/span from reading in the hundreds. Using the full window
    // here instead would also under-read a turn's opening — see BURST_FLOOR_MS.
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
    this.callCjk = 0
    this.callAscii = 0
    this.callIds = 0
    this.callFirstAt = 0
    this.callLastAt = 0
  }

  /** Calibrated token total held in the window (diagnostics/tests). */
  windowTokens(): number {
    this.prune()
    let ids = 0
    let cjk = 0
    let ascii = 0
    for (const sample of this.samples) {
      ids += sample.ids
      cjk += sample.cjk
      ascii += sample.ascii
    }
    // The relay reports every call on this session's socket, subagents
    // included (they share the session id), so an ids window is complete and
    // must not have a text estimate added on top of it.
    if (ids > 0) return ids
    return cjk * this.kCjk + ascii * this.kAscii
  }

  private noteCallFrame(now: number, cjk = 0, ascii = 0, ids = 0): void {
    if (!this.callOpen) return
    if (this.callFirstAt === 0) this.callFirstAt = now
    this.callLastAt = now
    this.callCjk += cjk
    this.callAscii += ascii
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
    return sample.cjk * this.kCjk + sample.ascii * this.kAscii
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
  const { cjk, ascii } = textUnits(text)
  return cjk + ascii
}
