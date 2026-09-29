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
 * ## How the reading is formed
 *
 * Tokens are accumulated into fixed **125 ms buckets**, and the reading is the
 * average of the last 8 of them — mean tokens per second over the last second,
 * recomputed as each bucket closes (so the number moves 8 times a second). A
 * bucket's tokens are always divided by the full 125 ms, never by how much of it
 * had elapsed, which is what stops a partial closing bucket from spiking.
 *
 * The rest of the rules are about the edges, where a bucket average would
 * otherwise lie:
 *
 *  - **Start**: the first 125 ms of a turn can carry a burst (a replayed prefix,
 *    a backlog handed over at once), so nothing is shown until a second bucket
 *    exists and the burst is only one part of an average.
 *  - **End**: the closing bucket is partial, so it is balanced with the one
 *    before it (see settle()).
 *  - **Pauses**: a bucket with no tokens counts as zero, so a real pause reads as
 *    the dip it is. A silence long enough to empty the reading window switches
 *    the display to the held value; a silence past LIVE_GAP_MS also drops the
 *    grid, so the reading after a tool finishes is this burst's speed and not an
 *    average polluted by the seconds of zeros before it.
 *  - **After it stops**: the held value stays readable for as long as the
 *    indicator's idle-hide allows. It is the real `output_tokens / decode span`
 *    when endCall() saw one (the engine's own account of the turn), and the
 *    ≤1.5 s bucket average otherwise (run meters, which have no usage of their
 *    own).
 *
 * Session lifecycle:
 *  - hasStreamed() is true once any content arrived; the UI stays visible.
 *  - hasLiveSamples() is true only while frames are still arriving, which is what
 *    keeps a finished subagent out of the aggregate sum.
 *  - value() returns the live bucket average while the stream is alive and the
 *    held value afterwards.
 */

// ── Bucketing ─────────────────────────────────────────────────────────────
/**
 * The reading is built from fixed 125 ms buckets.
 *
 * A bucket's tokens are divided by the full 125 ms, never by however much of it
 * had actually elapsed. That keeps a partial closing bucket from spiking, and it
 * means the grid never has to know when a stream stopped mid-bucket.
 */
const BUCKET_MS = 125
/** Buckets averaged for the live reading: 8 × 125 ms = 1 s. */
const READ_BUCKETS = 8
/**
 * How long a silence may last while the reading is still called "live". Once it
 * empties the whole reading window there is nothing left to average, so the
 * indicator switches to the held value rather than decaying toward zero.
 */
const LIVE_MS = READ_BUCKETS * BUCKET_MS
/** Buckets averaged for the value held after a stream ends: 12 × 125 ms = 1.5 s. */
const HOLD_BUCKETS = 12
/**
 * Ring capacity. Only the last 12 buckets are ever *read*, but the ring is much
 * wider than that on purpose: when a stall hands over a backlog at once, its
 * tokens have to be spread back over the empty buckets the stall occupied, and
 * spreading only works if those buckets are still held. Spreading inside the
 * reading window would change nothing (a mean is sum-preserving) — the dilution
 * comes precisely from pushing tokens back out of it. 64 buckets covers an 8 s
 * stall, which is past any tool pause seen here, and costs a few hundred bytes.
 */
const RING_SIZE = 64
/** Fewer completed buckets than this and there is no reading yet (see value()). */
const MIN_BUCKETS_FOR_READ = 2
/**
 * Silence past this means the stream has stopped: the reading switches to its
 * held value, and the bucket grid is dropped so the next frame starts a fresh
 * measurement. Without the drop, a frame arriving after a tool ran for ten
 * seconds would be averaged together with the zeros of those ten seconds and
 * read far below the truth for the whole first second after it resumed.
 */
const LIVE_GAP_MS = 1500
/**
 * A bucket carrying more than this many tokens per second is a backlog, not a
 * decode. A stall — a tool running, a thought block — makes the relay hand over
 * everything it accumulated at once, and charging that to a single 125 ms reads
 * as a burst (a 500-token flush would show 4000 t/s against a true 200). Its
 * tokens are spread back over the empty buckets before it, which is the stall
 * they were really generated across.
 */
const MAX_BUCKET_TPS = 5_000
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/
const WHITESPACE_RE = /\s/
const NON_CJK_TOKEN_WEIGHT = 1 / 3.5
/**
 * Tokens per CJK character.
 *
 * 1.0 is right for this engine, measured directly rather than inferred: asking
 * the local engine (zxsv-ai / Qwen3.8-27B) for 200 Chinese characters and
 * dividing its own `completion_tokens` gave 1.003 on both models. (A earlier
 * attempt to fit this from historical subagent transcripts reported ~0.65, but
 * that is an artefact of those records: their `usage.output_tokens` does not
 * cover everything their text contains, so the ratio came out under 1. Direct
 * measurement against the engine supersedes it.)
 *
 * Note the non-CJK term is only ever a middle ground — the engine's own density
 * for Latin text varies about 2.5x with content type (prose 0.19 tokens/char,
 * code 0.25, JSON 0.47), which no single coefficient can track. See
 * NON_CJK_TOKEN_WEIGHT.
 */
export const DEFAULT_K_CJK = 1

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

/**
 * One 125 ms slice of a stream, addressed by its index on the meter's clock
 * grid. Slots are matched by `index`, so a slot nobody wrote reads as zero
 * without having to be allocated — a ten-second stall costs nothing.
 */
type Bucket = {
  index: number
  /** Relayed exact token count; when non-zero it is the whole of this bucket. */
  ids: number
  cjk: number
  ascii: number
  /**
   * This bucket's content was judged unmeasurable and thrown away (see
   * depileBucket). Sticky, so the tokens that keep arriving in the same bucket do
   * not rebuild it a few units at a time and leak back into the reading.
   */
  dropped?: boolean
}

/**
 * Which clock the bucket grid is laid out on.
 *
 * - `generation` — the epoch ms the server received each chunk (`serverTs`,
 *   surfaced as `generatedAt`). It describes the decoder's own cadence.
 * - `arrival` — this client's `performance.now()` when the frame was handled.
 *   It describes the client's scheduler, which a busy main thread compresses:
 *   queued frames are drained at once and land milliseconds apart carrying
 *   hundreds of tokens, which reads far above the real rate.
 *
 * ⚠️ The two are not interchangeable and must never be subtracted from one
 * another: `serverTs` is epoch ms while `performance.now()` counts from page
 * load, so the difference is ~1.7e12. The choice is therefore sticky per meter
 * (see `degradeToArrival`), and only the chosen clock ever measures bucket
 * spacing. Elapsed silence is always taken on the arrival clock.
 */
export type TpsClock = 'generation' | 'arrival'

let tpsClockDefault: TpsClock = 'generation'

/**
 * Choose the clock new meters start on. The generation clock is the default
 * because the server timestamps frames as the model produces them; the arrival
 * clock remains available as the fallback for relays that do not stamp.
 */
export function setTpsClock(clock: TpsClock): void {
  tpsClockDefault = clock
}

export function getTpsClock(): TpsClock {
  return tpsClockDefault
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
  /** The last RING_SIZE buckets, addressed by `index % RING_SIZE`. */
  private ring: Array<Bucket | undefined> = new Array(RING_SIZE)
  /** Grid origin: the chosen clock's reading at the first bucket of this run. */
  private originClock = 0
  /** The arrival clock at that same moment (needed to age the grid on read). */
  private originArrival = 0
  /** Index of the newest bucket written, or -1 before the first frame. */
  private lastIndex = -1
  /** Arrival clock of the most recent frame — liveness, hide, and gap detection. */
  private lastPushAt = 0
  private everStreamed = false
  /** Buckets carry ids rather than text; used by source(). */
  private sawIds = false
  /** The chosen clock; degrades to arrival for good if a frame arrives unstamped. */
  private clock: TpsClock
  /**
   * The reading shown once the stream stops: the ≤1.5 s bucket average, or the
   * real `tokens / decode span` when endCall() supplied one. Stored as a number,
   * not recomputed from the ring, because ending the stream drops the grid.
   */
  private heldValue = 0
  /** Real-token anchor from endCall(); wins over the bucket average. */
  private heldOverride: number | null = null
  private ended = false
  /** The tail has been balanced and the held value computed for this grid. */
  private settled = false

  // Learned coefficients and the least-squares accumulators behind them. They
  // describe the model, not this stream, so reset() keeps them.
  private kCjk = DEFAULT_K_CJK
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

  constructor(clock: TpsClock = tpsClockDefault) {
    this.clock = clock
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
  push(
    text: string,
    options: {
      wholeBlock?: boolean
      external?: boolean
      stream?: string
      generatedAt?: number
    } = {},
  ): void {
    const now = performance.now()
    const external = options.external === true
    const { cjk, ascii } = text ? textUnits(text) : { cjk: 0, ascii: 0 }
    if (cjk === 0 && ascii === 0) {
      this.markFrame(now)
      if (!external) this.noteCallFrame(now)
      return
    }
    const index = this.placeFrame(now, options.generatedAt)
    if (index >= 0) {
      const bucket = this.bucketAt(index)
      // A bucket already judged unmeasurable stays empty: these tokens are part of
      // the same unmeasurable hand-over, and letting them rebuild it a few units at
      // a time would leak the backlog back into the reading. Liveness is still
      // recorded below, so the stream does not look stopped.
      if (!bucket.dropped) {
        bucket.cjk += cjk
        bucket.ascii += ascii
        this.depileBucket(index)
      }
    }
    if (!external) this.noteCallFrame(now, cjk, ascii)
  }

  /**
   * Feed a real token count relayed by the sidecar (the engine's per-chunk
   * `token_ids`). These are exact, so they bypass calibration entirely — and a
   * bucket that carries them uses them alone, never adding a text estimate on
   * top (see bucketTokens).
   */
  pushTokens(
    tokens: number,
    options: { stream?: string; generatedAt?: number } = {},
  ): void {
    const count = Math.floor(tokens)
    if (!Number.isFinite(count) || count <= 0) return
    const now = performance.now()
    const index = this.placeFrame(now, options.generatedAt)
    if (index >= 0) {
      const bucket = this.bucketAt(index)
      if (!bucket.dropped) {
        bucket.ids += count
        this.depileBucket(index)
      }
    }
    this.sawIds = true
    this.noteCallFrame(now, 0, 0, count)
  }

  /** True once this session has ever received streamed content. */
  hasStreamed(): boolean {
    return this.everStreamed
  }

  /**
   * True while frames are still arriving — this stream is emitting *now*.
   *
   * Deliberately on the arrival clock only, and deliberately narrow (the gap
   * floor, not the hold window): it is what stops a finished subagent from
   * feeding the aggregate sum. Its own value() still serves the held number for a
   * run page or a lone session for the full hold period; see
   * aggregateMeterReadings, which already splits the two questions that way.
   */
  hasLiveSamples(): boolean {
    return this.lastPushAt > 0 && performance.now() - this.lastPushAt <= LIVE_GAP_MS
  }

  /** Arrival clock of the most recent streamed chunk (0 if never). */
  lastDataTime(): number {
    return this.lastPushAt
  }

  /** Which signal the current reading is drawing on (for UI/diagnostics). */
  source(): TpsSource {
    return this.sawIds ? 'ids' : 'char'
  }

  /** Bump liveness without recording units (a frame the exact source already covers). */
  touch(): void {
    this.markFrame(performance.now())
  }

  /**
   * Record that a frame arrived. Liveness only — no units, no grid change, and
   * deliberately no clock handling: `touch()` is called for text frames whose
   * counts are already carried by the exact ids relay, and degrading the clock
   * on those would drop the meter to the arrival clock for no reason.
   */
  private markFrame(now: number): void {
    this.lastPushAt = now
    this.everStreamed = true
  }

  /** Learned coefficients, for persistence per model (see tpsCalibration). */
  calibration(): TpsCalibration {
    return { kCjk: this.kCjk, kAscii: this.kAscii }
  }

  // ── Bucket grid ─────────────────────────────────────────────────────────

  /**
   * Drop the grid and re-anchor on the next frame. Used when the stream has
   * demonstrably stopped (a gap longer than LIVE_GAP_MS) and when the clock
   * itself has to change: keeping old buckets would average the new frames
   * together with buckets measured on a different clock, or with the zeros of a
   * pause that was never part of this measurement.
   */
  private clearGrid(): void {
    this.ring = new Array(RING_SIZE)
    this.originClock = 0
    this.originArrival = 0
    this.lastIndex = -1
    this.settled = false
  }

  /**
   * Fall back to the arrival clock for good.
   *
   * A meter on the generation clock that receives a frame with no timestamp
   * cannot keep that clock: the two are different epochs, so one unstamped frame
   * would place its bucket ~1.7e12 ms away from the others. Arrival is the only
   * clock that is always available, so the meter drops to it and stays there.
   */
  private degradeToArrival(): void {
    this.clock = 'arrival'
    this.clearGrid()
  }

  /**
   * Locate the bucket this frame belongs to on the meter's clock grid, opening
   * the grid if needed. Returns -1 for a frame that cannot be placed (an
   * out-of-order stamp older than the ring) — the caller then records nothing
   * but liveness.
   */
  private placeFrame(now: number, generatedAt: number | undefined): number {
    if (this.clock === 'generation' && generatedAt === undefined) this.degradeToArrival()
    const useGenerated = this.clock === 'generation' && generatedAt !== undefined
    const sampleClock = useGenerated ? generatedAt : now

    // A long silence ended the measurement: start a fresh grid on this frame so
    // the reading that follows reflects this burst, not the pause before it.
    if (this.lastPushAt > 0 && now - this.lastPushAt > LIVE_GAP_MS) {
      // Keep the reading we had before dropping the grid. Everything this grid
      // could say is about to be thrown away, and the honest thing to show while
      // the meter re-measures is the last speed it actually measured — not the
      // zero an empty grid reports, which a reader holds on to and the indicator
      // freezes on (its own anti-flash rule keeps the previous number while the
      // meter reads ~0).
      const outgoing = this.readGrid()
      if (outgoing > 0) this.heldValue = outgoing
      this.clearGrid()
    }
    if (this.originClock === 0) {
      this.originClock = sampleClock
      this.originArrival = now
    }

    this.settled = false
    let index = Math.floor((sampleClock - this.originClock) / BUCKET_MS)
    if (index < 0) index = 0
    if (index < this.lastIndex) {
      // Out of order (only the generation clock can do this). Merge it into its
      // own bucket when that bucket is still in the ring, otherwise let it go
      // from the rate — a stale stamp says nothing about the current pace.
      if (this.lastIndex - index >= RING_SIZE) {
        this.markFrame(now)
        return -1
      }
    } else {
      this.lastIndex = index
    }
    this.markFrame(now)
    return index
  }

  /** The writable slot for `index`, allocated on first use. */
  private bucketAt(index: number): Bucket {
    const slot = index % RING_SIZE
    const existing = this.ring[slot]
    if (existing && existing.index === index) return existing
    const bucket: Bucket = { index, ids: 0, cjk: 0, ascii: 0 }
    this.ring[slot] = bucket
    return bucket
  }

  /** Token count of bucket `index`; 0 for a slot nobody wrote (an empty 125 ms). */
  private bucketTokens(index: number): number {
    if (index < 0) return 0
    const bucket = this.ring[index % RING_SIZE]
    if (!bucket || bucket.index !== index) return 0
    if (bucket.ids > 0) return bucket.ids
    return bucket.cjk * this.kCjk + bucket.ascii * this.kAscii
  }

  /**
   * Index of the newest *completed* bucket, i.e. the last one a reading may
   * include. -1 when nothing has completed.
   *
   * On the arrival clock that is how much time has passed, less the bucket
   * currently in progress: including the in-progress one would count a partial
   * 125 ms as a full empty bucket and silently push the oldest bucket out of the
   * window (measured: a steady 104 t/s read as 91).
   *
   * The generation clock has no "now" of its own — the newest stamp is the last
   * bucket that can hold anything, and nothing follows it to make it look partial.
   */
  private readIndex(now: number): number {
    if (this.clock === 'generation') return this.lastIndex
    if (this.originArrival === 0) return -1
    return Math.floor((now - this.originArrival) / BUCKET_MS) - 1
  }

  /**
   * Spread an over-limit bucket back over the empty ones before it.
   *
   * A stall makes the relay hand over everything it accumulated at once; charged
   * to a single 125 ms that reads as a thousands-per-second burst. The tokens
   * really belong to the stall they were generated across, so they are pushed
   * back into the empty buckets in front of them, up to the last bucket that had
   * content. This is the discrete form of the anchor the old per-sample gate kept.
   */
  private depileBucket(index: number): void {
    const limit = MAX_BUCKET_TPS * (BUCKET_MS / 1000)
    const bucket = this.ring[index % RING_SIZE]
    if (!bucket || bucket.index !== index) return
    if (bucket.dropped) return
    const tokens = this.bucketTokens(index)
    if (tokens <= limit) return
    // The most recent bucket before this one that had content: the far side of
    // the stall this backlog was generated across.
    let previous = -1
    for (let i = index - 1; i >= 0 && index - i < RING_SIZE; i--) {
      if (this.bucketTokens(i) > 0) {
        previous = i
        break
      }
    }
    if (previous < 0) {
      // Nothing measured precedes this bucket, so there is no interval these
      // tokens could belong to. That happens when a tab was throttled in the
      // background: the engine kept decoding and the whole backlog is handed over
      // in the instant the client finally runs again — one arrival bucket holding
      // minutes of output. This clock cannot say when those tokens were made, and
      // charging them to a single 125 ms reads as tens of thousands per second
      // (measured: a true 104 t/s read as 25 012, capped at 9999 on screen for the
      // second it took the bucket to leave the window) — so they are not measured
      // at all. The reading picks up from the frames that follow. The same lands
      // when the content is real but further back than the ring can address, where
      // spreading would divide minutes of tokens by eight seconds and over-read.
      bucket.dropped = true
      this.rescaleBucket(index, 0)
      return
    }
    const spread = index - previous
    // Adjacent to the previous content: no stall, so this really is one dense
    // 125 ms and dividing it by more time would invent a rate.
    if (spread < 2) return
    const template = { cjk: bucket.cjk, ascii: bucket.ascii, ids: bucket.ids }
    for (let i = previous + 1; i <= index; i++) {
      this.writeBucketLike(i, template, tokens / spread)
    }
  }

  /**
   * Set a bucket to hold `tokens`, split between the classes the way `template`
   * is split. Used when relocating a backlog into buckets that are still empty,
   * where a proportional rescale has nothing to scale from.
   */
  private writeBucketLike(
    index: number,
    template: { cjk: number; ascii: number; ids: number },
    tokens: number,
  ): void {
    const bucket = this.bucketAt(index)
    if (template.ids > 0) {
      bucket.ids = Math.max(0, Math.round(tokens))
      bucket.cjk = 0
      bucket.ascii = 0
      return
    }
    const total = template.cjk + template.ascii
    const scale = total > 0 ? tokens / total : 0
    bucket.cjk = template.cjk * scale
    bucket.ascii = template.ascii * scale
    bucket.ids = 0
  }

  /**
   * Average tokens/second over the last `count` buckets ending at `endIndex`.
   *
   * Always divided by the full bucket width, and by the number of buckets
   * actually averaged — never by a fixed 8 while fewer have elapsed, which would
   * read the first second of every turn a fraction of its true speed.
   *
   * A bucket thrown away as unmeasurable is left out of the divisor rather than
   * counted as an empty 125 ms: it is a hole in the measurement, not a pause. A
   * never-written bucket is different — the stream really did emit nothing for
   * that 125 ms — and stays in the divisor, which is what makes a pause read as a
   * dip instead of being glossed over.
   */
  private averageOver(endIndex: number, count: number): number {
    let tokens = 0
    let measured = 0
    for (let i = 0; i < count; i++) {
      const index = endIndex - i
      this.depileBucket(index)
      const bucket = this.ring[index % RING_SIZE]
      if (bucket && bucket.index === index && bucket.dropped) continue
      measured++
      tokens += this.bucketTokens(index)
    }
    if (measured <= 0) return 0
    return tokens / (measured * (BUCKET_MS / 1000))
  }

  /** Buckets completed so far in this run, counting from the grid origin. */
  private elapsedBuckets(now: number): number {
    const end = this.readIndex(now)
    if (end < 0) return 0
    return end + 1
  }

  /**
   * What this grid last measured, judged from its newest *written* bucket rather
   * than from `now`.
   *
   * `now` is useless for this: it is called when the grid is about to be dropped
   * for a long silence, so "now" has already run far past the end and would
   * address buckets nobody wrote (reading 0). 0 also means "nothing measured",
   * which is why the caller only keeps a positive result.
   */
  private readGrid(): number {
    const end = this.lastIndex
    if (end < 0) return 0
    const count = Math.min(READ_BUCKETS, end + 1)
    if (count < MIN_BUCKETS_FOR_READ) return 0
    return this.averageOver(end, count)
  }

  /**
   * The value to show once the stream has stopped: the engine's real rate when
   * endCall() saw one, otherwise the average over the last ≤1.5 s of buckets.
   */
  private held(): number {
    return this.heldOverride ?? this.heldValue
  }

  /**
   * Balance the closing bucket and freeze the held reading.
   *
   * The final bucket is a partial one — the stream stopped somewhere inside its
   * 125 ms — so on its own it under-reads. Balancing it with the bucket before it
   * gives the tail the weight of a full bucket rather than one-eighth of one.
   *
   * Runs at the end of every API call (not only at the end of the turn): each
   * call's tail is a partial bucket, and re-balancing an already-balanced pair is
   * a no-op, so calling it more than once costs nothing.
   */
  private settle(): void {
    this.settled = true
    // The *last written* bucket, not the current time's: settling happens after
    // the stream stopped, and on the arrival clock "now" has already run past the
    // end — balancing two buckets nobody wrote would hold a speed of zero.
    const end = this.lastIndex
    if (end < 1) {
      // Nothing settled — a stream that died inside its first bucket. There is
      // no honest bucket average to hold; a heldOverride (if any) still stands.
      return
    }
    const balanced = (this.bucketTokens(end) + this.bucketTokens(end - 1)) / 2
    this.rescaleBucket(end, balanced)
    this.rescaleBucket(end - 1, balanced)
    // A window with nothing in it measures nothing, and 0 is not a speed — it is
    // "no reading". Keeping whatever was last measured beats overwriting it with a
    // zero that a reader (and the indicator's anti-flash rule) would then hold on
    // to. Reached when the grid was just re-anchored, e.g. the answer finished
    // while the tab was in the background.
    const avg = this.averageOver(end, Math.min(HOLD_BUCKETS, end + 1))
    if (avg > 0) this.heldValue = avg
  }

  /** Set a bucket's token count, keeping the class split proportional. */
  private rescaleBucket(index: number, tokens: number): void {
    const bucket = this.bucketAt(index)
    const original = bucket.ids > 0
      ? bucket.ids
      : bucket.cjk * this.kCjk + bucket.ascii * this.kAscii
    const scale = original > 0 ? tokens / original : 0
    bucket.cjk *= scale
    bucket.ascii *= scale
    bucket.ids = Math.round(bucket.ids * scale)
  }

  /**
   * The stream has stopped for good: settle the tail and freeze the reading.
   *
   * Idempotent, and the reader treats a long silence as an implicit end, so
   * correctness never depends on a terminal notification arriving.
   */
  endStream(): void {
    if (this.ended) return
    this.ended = true
    this.settle()
  }

  /**
   * Seed coefficients learned from earlier sessions with the same model.
   *
   * `undefined` leaves the current coefficients alone; `null` means "this model
   * has nothing remembered" and resets to the built-in defaults (so a model
   * switch re-learns instead of inheriting the previous model's numbers).
   */
  setCalibration(calibration: TpsCalibration | null | undefined): void {
    if (calibration === undefined) return
    if (calibration === null) {
      this.kCjk = DEFAULT_K_CJK
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
   * The real `tokens / decode span` becomes the held reading: it is the engine's
   * own account of the turn, so it beats anything the bucket grid can infer, and
   * it is what the 5-minute hold shows after the stream stops.
   *
   * Deliberately does NOT mark the stream as ended: one turn is several calls
   * (a tool loop closes and reopens), so ending here would freeze the reading
   * mid-turn. `endStream()` is the terminal signal; a long silence is the
   * implicit one.
   *
   * Learns the coefficients only when the call carried no exact ids (those need
   * no calibration) and the sample is big enough to trust.
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
    if (spanMs > 0) {
      this.heldOverride = real / (spanMs / 1000)
      this.settle()
    }

    if (callIds > 0) return false
    return this.learnSample(callCjk, callAscii, real)
  }


  /**
   * Fold one sample of (class units, real tokens) into the coefficients, applying
   * the guards that keep a replay or a too-small sample from teaching a lie.
   */
  private learnSample(cjk: number, ascii: number, real: number): boolean {
    const units = cjk + ascii
    if (units < MIN_UNITS_TO_LEARN) return false
    // A fallback/retry replays the prefix, inflating units without inflating
    // real tokens. Drop the sample instead of teaching the coefficients a lie.
    if (this.unitMean !== null && units > OUTLIER_UNIT_FACTOR * this.unitMean) return false
    if (real < MIN_REAL_TOKENS_TO_LEARN) return false
    this.unitMean = this.unitMean === null
      ? units
      : this.unitMean + UNIT_MEAN_EWMA_ALPHA * (units - this.unitMean)
    return this.learn(cjk, ascii, real)
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
   * The reading: mean tokens/second over the last second, in 125 ms steps.
   *
   * Four things decide which number that is.
   *
   *  - Nothing has streamed → nothing to show.
   *  - The stream has stopped (an explicit endStream() or a silence longer than
   *    LIVE_GAP_MS) → the held reading.
   *  - Fewer than two buckets have completed → the held reading too. The first
   *    125 ms of a turn can carry a burst (a replayed prefix, a backlog handed
   *    over at once), and showing that alone is the spike the startup rule exists
   *    to avoid; from the second bucket on, that first one is only one part of an
   *    average.
   *  - Otherwise the average of up to the last READ_BUCKETS buckets. Buckets with
   *    no tokens count as zero, so a genuine pause reads as the dip it is.
   *
   * Safe to call repeatedly (the indicator polls it twice per frame, once for the
   * cadence and once for the value): it only reads, and the depile it may perform
   * is idempotent.
   */
  value(): number {
    if (!this.everStreamed) return 0
    const now = performance.now()
    // A silence long enough to empty the whole reading window means there is no
    // live speed left to report — show what the last one was. (The grid itself
    // survives until LIVE_GAP_MS; only this hand-off is earlier.) Settling here
    // as well as in endStream() is what makes the implicit end a real one: a
    // finished run's terminal notice arrives as a task event, not as a frame, so
    // this read is the only close its meter ever sees.
    if (this.ended || (this.lastPushAt > 0 && now - this.lastPushAt > LIVE_MS)) {
      if (!this.settled) this.settle()
      return this.held()
    }
    const elapsed = this.elapsedBuckets(now)
    if (elapsed < MIN_BUCKETS_FOR_READ) return this.held()
    const count = Math.min(READ_BUCKETS, elapsed)
    return this.averageOver(this.readIndex(now), count)
  }

  /**
   * Drop the measurement, keeping the learned coefficients.
   *
   * Fires when the source switches (a text-measured stream suddenly reporting
   * exact ids, on reconnect, on retry). The tokens either side of the switch
   * belong to one continuous generation, but they are measured in different
   * units and possibly on different clocks, so the grid restarts rather than
   * averaging two incomparable halves. The held reading is left alone — it
   * describes the turn that is ending, and is still the honest number to show.
   */
  reset(): void {
    this.clearGrid()
    this.everStreamed = false
    this.lastPushAt = 0
    this.sawIds = false
    this.ended = false
    this.callOpen = false
    this.callCjk = 0
    this.callAscii = 0
    this.callIds = 0
    this.callFirstAt = 0
    this.callLastAt = 0
  }

  /**
   * Token count of every bucket the ring currently holds, oldest first
   * (diagnostics/tests). Lets a test see how a backlog was spread, which a mean
   * over the window cannot show.
   */
  bucketTokensByIndex(): Array<{ index: number; tokens: number }> {
    const out: Array<{ index: number; tokens: number }> = []
    for (const bucket of this.ring) {
      if (!bucket) continue
      out.push({ index: bucket.index, tokens: this.bucketTokens(bucket.index) })
    }
    return out.sort((a, b) => a.index - b.index)
  }

  /**
   * Token total over the reading window right now (diagnostics/tests).
   *
   * A grid with any exact ids reads as ids only: the relay's counts cover the
   * whole stream, so adding the text estimate on top would count it twice.
   */
  windowTokens(): number {
    const now = performance.now()
    const end = this.readIndex(now)
    if (end < 0) return 0
    const count = Math.min(READ_BUCKETS, end + 1)
    let ids = 0
    let text = 0
    for (let i = 0; i < count; i++) {
      const index = end - i
      this.depileBucket(index)
      const bucket = this.ring[index % RING_SIZE]
      if (!bucket || bucket.index !== index) continue
      ids += bucket.ids
      text += bucket.cjk * this.kCjk + bucket.ascii * this.kAscii
    }
    return ids > 0 ? ids : text
  }

  private noteCallFrame(now: number, cjk = 0, ascii = 0, ids = 0): void {
    if (!this.callOpen) return
    if (this.callFirstAt === 0) this.callFirstAt = now
    this.callLastAt = now
    this.callCjk += cjk
    this.callAscii += ascii
    this.callIds += ids
  }

}

/**
 * Aggregate reading for a session's TPS indicator. `tps` is the team-wide
 * decode speed (own stream + every running subagent); `activeSubs` is how many
 * of those subagents are emitting right now.
 */
export type TpsAggregate = {
  visible: boolean
  tps: number
  /** Subagent meters with fresh samples in the window (emitting right now). */
  activeSubs: number
}

/**
 * Build the session's reading as the sum of every stream decoding for it: the
 * session's own output plus each running subagent's.
 *
 *  - Each meter rates **its own stream only** — chatStore feeds the parent's
 *    meter the parent's own prose and each run's meter that run's deltas (see
 *    ingestSubagentTps) — so the text behind the meters is disjoint and adding
 *    the rates adds concurrent decoders rather than double-counting tokens.
 *    A run that has finished stops contributing the moment its window drains,
 *    which is what keeps the total from sitting above the truth.
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

  let tps = own.hasLiveSamples() ? own.value() : 0
  let activeSubs = 0
  for (const meter of subordinates) {
    if (!meter.hasLiveSamples()) continue
    activeSubs += 1
    tps += meter.value()
  }
  if (tps <= 0) {
    // Nothing is decoding this instant. Hold the session's own last speed (the
    // turn-ending rate) so a lone session reads exactly as it did before
    // aggregation; if its own stream never produced anything either, there is
    // no honest reading to show.
    if (!own.hasStreamed()) return { visible: false, tps: 0, activeSubs: 0 }
    tps = own.value()
  }
  return { visible: true, tps, activeSubs }
}

/**
 * Coefficients {@link estimateTokens} should use, when a model's have been
 * learned. `null` means the neutral default (one token per CJK character, one
 * per 3.5 others).
 *
 * Module-level because the callers are pure functions invoked from render (the
 * thought badge, the activity digest) and a client is looking at one model at a
 * time; the alternative is threading a model id through every one of them. A
 * client showing two models at once would need this per session.
 */
let estimationCalibration: TpsCalibration | null = null

/**
 * Point the content-based estimates at a model's learned tokenizer density.
 *
 * The badge and the digest can only measure characters, so their number is a
 * guess until the meter has reconciled text against the real `output_tokens` a
 * call reported. Those learned coefficients are what makes the guess track the
 * real count (the meter learns them against real usage); using the neutral
 * default while the calibration sits unread in storage is what left the
 * estimate further off than it needed to be.
 */
export function setEstimationCalibration(calibration: TpsCalibration | null | undefined): void {
  estimationCalibration = calibration
    && Number.isFinite(calibration.kCjk) && calibration.kCjk > 0
    && Number.isFinite(calibration.kAscii) && calibration.kAscii > 0
    ? {
        kCjk: clamp(calibration.kCjk, K_MIN, K_MAX),
        kAscii: clamp(calibration.kAscii, K_MIN, K_MAX),
      }
    : null
}

export function estimateTokens(text: string): number {
  const { cjk, ascii } = textUnits(text)
  // Same shape, and the same neutral default, the meter uses — so a learned
  // calibration means the same thing in both places.
  const kCjk = estimationCalibration?.kCjk ?? DEFAULT_K_CJK
  const kAscii = estimationCalibration?.kAscii ?? 1
  return cjk * kCjk + ascii * kAscii
}
