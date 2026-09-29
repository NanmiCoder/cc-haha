import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  DEFAULT_K_CJK,
  TpsMeter,
  aggregateMeterReadings,
  estimateTokens,
  setEstimationCalibration,
  type TpsClock,
} from './tpsMeter'

/** One bucket, the grid's unit. Kept in step with BUCKET_MS. */
const BUCKET = 125

/**
 * Drive `performance.now()`. The meter reads it directly, so every test that
 * cares about timing has to move the same value the pushes see.
 */
function arrivalClock(start = 1_000_000) {
  const ref = { now: start }
  vi.spyOn(performance, 'now').mockImplementation(() => ref.now)
  return {
    get now() {
      return ref.now
    },
    set(ms: number) {
      ref.now = ms
    },
    advance(ms: number) {
      ref.now += ms
    },
  }
}

/**
 * An epoch-ms stand-in for `serverTs`. Kept far from `performance.now()` on
 * purpose: the two clocks are only ever used one at a time, and a test that
 * accidentally mixed them should look obviously wrong rather than plausible.
 */
const GEN_EPOCH = 1_700_000_000_000

/**
 * Feed `count` buckets of `tokens` each, one bucket apart, advancing the arrival
 * clock in step so the two stay consistent.
 */
function steady(
  meter: TpsMeter,
  clock: ReturnType<typeof arrivalClock>,
  count: number,
  tokens: number,
  gen: { at: number },
  opts: { from?: number } = {},
) {
  for (let i = 0; i < count; i++) {
    const generatedAt = opts.from === undefined ? gen.at : opts.from + i * BUCKET
    if (tokens > 0) meter.pushTokens(tokens, { generatedAt })
    clock.advance(BUCKET)
    gen.at += BUCKET
  }
}

afterEach(() => vi.restoreAllMocks())

describe('bucket reading', () => {
  it('reads the mean of the last second, and starts only from the second bucket', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    // 13 tokens per 125 ms is 104 t/s.
    const push = () => steady(meter, clock, 1, 13, gen)

    // The opening bucket alone is not a speed: a burst delivered in the first
    // 125 ms (a replayed prefix, a backlog) must not be shown as one.
    push()
    expect(meter.value()).toBe(0)

    // From the second bucket the reading exists, and its divisor is the number
    // of buckets actually elapsed — never a fixed 8, which would read the first
    // second of every turn low.
    push()
    expect(meter.value()).toBeCloseTo(104, 0)

    steady(meter, clock, 6, 13, gen)
    expect(meter.value()).toBeCloseTo(104, 0)
  })

  it('counts an empty bucket as zero, so a pause reads as the dip it is', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    steady(meter, clock, 2, 13, gen)

    // Four buckets with nothing in them, then the stream resumes.
    clock.advance(4 * BUCKET)
    gen.at += 4 * BUCKET
    steady(meter, clock, 1, 13, gen)

    // 3 buckets of 13 over 7 elapsed buckets ≈ 45 t/s, the pause included.
    expect(meter.value()).toBeCloseTo(39 / (7 * (BUCKET / 1000)), 0)
  })

  it('drops the grid after a long silence, so the resumed reading is not diluted', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    steady(meter, clock, 8, 13, gen)
    expect(meter.value()).toBeCloseTo(104, 0)

    // A tool runs for two seconds with nothing arriving.
    clock.advance(2000)
    gen.at += 2000
    // The reading window is empty, so the last speed is what stands.
    expect(meter.value()).toBeCloseTo(104, 0)

    // It resumes at the same rate. The grid restarted, so this burst's own mean
    // is shown rather than an average taken against the two seconds of zeros.
    steady(meter, clock, 8, 13, gen)
    expect(meter.value()).toBeCloseTo(104, 0)
    expect(meter.bucketTokensByIndex()).toHaveLength(8)
  })

  it('spreads a backlog over the stall it was generated across', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    // A little content, then a six-bucket stall, then the relay hands over
    // everything it accumulated at once.
    steady(meter, clock, 3, 10, gen)
    clock.advance(6 * BUCKET)
    gen.at += 6 * BUCKET
    steady(meter, clock, 1, 1200, gen)

    // Holding in one bucket it would read 1200/0.125 = 9600 t/s. Spread back
    // over the stall it is 1200 tokens over the 9 buckets since the content,
    // which is 1200/(9×0.125) ≈ 1067 t/s — and no single bucket carries it all.
    const buckets = meter.bucketTokensByIndex()
    expect(Math.max(...buckets.map((b) => b.tokens))).toBeLessThan(200)
    expect(meter.value()).toBeGreaterThan(900)
    expect(meter.value()).toBeLessThan(1250)
  })
})

describe('exact ids and the text estimate', () => {
  it('lets exact ids cover their bucket, so the same tokens are never counted twice', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    // The relay reports the engine's count for the very tokens the text frames
    // carry; both land in the same bucket.
    meter.pushTokens(10, { generatedAt: gen.at })
    meter.push('中'.repeat(50), { generatedAt: gen.at })
    clock.advance(BUCKET)
    meter.pushTokens(13, { generatedAt: gen.at + BUCKET })

    expect(meter.source()).toBe('ids')
    // 10 + 13, with the 50 characters adding nothing on top.
    expect(meter.windowTokens()).toBe(23)
  })

  it('estimates from the text when the relay sends no ids', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')
    for (let i = 0; i < 8; i++) {
      meter.push('中'.repeat(13))
      clock.advance(BUCKET)
    }
    expect(meter.source()).toBe('char')
    // 13 CJK characters are 13 tokens at the measured density, per 125 ms.
    expect(meter.value()).toBeCloseTo(104, 0)
  })
})

describe('closing the stream', () => {
  it('balances the partial closing bucket with the one before it', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    steady(meter, clock, 3, 100, gen)
    steady(meter, clock, 1, 20, gen) // the stream died inside this bucket
    meter.endStream()

    // On its own the closing bucket reads 20/0.125 = 160 t/s; balanced with its
    // neighbour both hold 60, so the tail stops under-reading. (The total is
    // unchanged — this redistributes the tail, it does not invent or lose it.)
    expect(meter.bucketTokensByIndex().map((b) => b.tokens)).toEqual([100, 100, 60, 60])
  })

  it('freezes a held reading of the last 1.5s, and keeps it', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    steady(meter, clock, 16, 13, gen)
    meter.endStream()

    // 12 buckets × 13 tokens = 156 over 1.5 s.
    expect(meter.value()).toBeCloseTo(104, 0)
    // Five minutes of silence must not decay it — the indicator's own idle rule
    // is what eventually hides the readout.
    clock.advance(4 * 60 * 1000)
    expect(meter.value()).toBeCloseTo(104, 0)
  })

  it('prefers the engine real rate over the bucket average when endCall saw one', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    meter.beginCall()
    steady(meter, clock, 3, 13, gen)

    // The CLI reported 120 tokens decoded over 2 s: 60 t/s, where the buckets
    // only saw the 39 tokens of the last few hundred ms.
    meter.endCall(120, 2000)
    clock.advance(2000)
    expect(meter.value()).toBeCloseTo(60, 5)
  })

  it('settles on its own when a run ends without a frame to say so', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')
    // No endStream() call: a finished background run announces itself as a task
    // event, not as a frame, so the meter only ever learns of it by silence.
    for (let i = 0; i < 8; i++) {
      meter.push('中'.repeat(13))
      clock.advance(BUCKET)
    }
    clock.advance(2000)
    expect(meter.value()).toBeCloseTo(104, 0)
  })
})

describe('clock discipline', () => {
  it('keeps reading the true rate through a compressed, batched arrival clock', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    let arrival = clock.now
    let generated = GEN_EPOCH
    for (let i = 0; i < 40; i++) {
      generated += BUCKET
      // This client is busy: it drains five frames per generation interval.
      arrival += BUCKET / 5
      clock.set(arrival)
      meter.pushTokens(13, { generatedAt: generated })
    }

    // The decoder really did 13 tokens per 125 ms.
    expect(meter.value()).toBeCloseTo(104, 0)

    // The same timings with no stamps read five times high — which is why the
    // generation clock is the default and arrival is only the fallback.
    const arrived = new TpsMeter('arrival')
    let t = 1_000_000
    for (let i = 0; i < 40; i++) {
      t += BUCKET / 5
      clock.set(t)
      arrived.pushTokens(13)
    }
    expect(arrived.value()).toBeGreaterThan(300)
  })

  it('falls back to the arrival clock for good once a frame arrives unstamped', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    steady(meter, clock, 1, 13, gen)

    // No server timestamp on this one. The two clocks are different epochs, so
    // the grid restarts on arrival rather than mixing them (which would place
    // this bucket ~1.7e12 ms from the others).
    meter.pushTokens(13)
    clock.advance(BUCKET)
    meter.pushTokens(13)
    clock.advance(BUCKET)
    meter.pushTokens(13)

    expect(meter.value()).toBeCloseTo(104, 0)
  })
})

describe('token estimation', () => {
  it('estimates tokens: CJK 1:1, full-width punctuation counted, ASCII 1:3.5, whitespace free', () => {
    // 4 CJK chars + 1 full-width comma → 5 tokens.
    expect(estimateTokens('你好世界，')).toBeCloseTo(5, 5)
    // 7 ASCII chars → 2 tokens (7 / 3.5).
    expect(estimateTokens('abcdefg')).toBeCloseTo(2, 5)
    // Whitespace and newlines carry no tokens of their own.
    expect(estimateTokens('a b\nc')).toBeCloseTo(3 / 3.5, 5)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   \n\t')).toBe(0)
  })

  it("estimates with the model's learned coefficients when one is set", () => {
    setEstimationCalibration({ kCjk: 0.8, kAscii: 1.6 })
    expect(estimateTokens('你好世界，')).toBeCloseTo(5 * 0.8, 5)
    expect(estimateTokens('abcdefg')).toBeCloseTo((7 / 3.5) * 1.6, 5)

    // Clearing returns to neutral, so a session with no calibration behaves
    // exactly as it did before the coefficients existed.
    setEstimationCalibration(null)
    expect(estimateTokens('你好世界，')).toBeCloseTo(5, 5)
    expect(estimateTokens('abcdefg')).toBeCloseTo(2, 5)
  })

  it('ignores a non-positive or malformed calibration', () => {
    setEstimationCalibration({ kCjk: 0, kAscii: 1.5 })
    expect(estimateTokens('你好世界，')).toBeCloseTo(5, 5)
    setEstimationCalibration(undefined)
    expect(estimateTokens('abcdefg')).toBeCloseTo(2, 5)
  })
})

describe('calibration learning', () => {
  /** 40 frames of six latin characters at 10 ms — 400 ms, all inside one window. */
  function latinCall(meter: TpsMeter, clock: ReturnType<typeof arrivalClock>) {
    meter.beginCall()
    for (let i = 0; i < 40; i++) {
      clock.advance(10)
      meter.push('x'.repeat(6))
    }
    // Let the closing bucket complete: only completed buckets are read, so
    // without this the last few frames are legitimately not in the window yet.
    clock.advance(BUCKET)
  }

  it('learns from the real usage so the window matches the real token total', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')

    // Latin text, so the neutral 1.0 under-reads: 240 characters are 68.6 units.
    latinCall(meter, clock)
    expect(meter.windowTokens()).toBeLessThan(80)

    // The real usage from that call teaches the coefficients (120 tokens for
    // those 68.6 units ⇒ kAscii ≈ 1.75).
    meter.endCall(120, 700)
    expect(meter.calibration().kAscii).toBeCloseTo(1.75, 1)

    // A fresh call now reads the real total for the same text.
    meter.reset()
    latinCall(meter, clock)
    expect(meter.windowTokens()).toBeCloseTo(120, 0)
  })

  it('rejects a ballooned call (replayed prefix) and clamps the coefficients', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')
    meter.setCalibration({ kCjk: 1, kAscii: 1 })

    // Establish a normal call size first (100 latin frames ≈ 171 units).
    meter.beginCall()
    for (let i = 0; i < 100; i++) { clock.advance(5); meter.push('x'.repeat(6)) }
    meter.endCall(100, 2000)
    const baseline = meter.calibration().kAscii

    // A fallback replay delivers the whole prefix again as one huge unit count.
    meter.beginCall()
    for (let i = 0; i < 1000; i++) { clock.advance(1); meter.push('x'.repeat(6)) }
    meter.endCall(100, 2000)
    expect(meter.calibration().kAscii).toBe(baseline)

    // A genuine extreme ratio still lands inside the clamp.
    meter.beginCall()
    for (let i = 0; i < 100; i++) { clock.advance(5); meter.push('x'.repeat(6)) }
    meter.endCall(100_000, 2000)
    expect(meter.calibration().kAscii).toBeLessThanOrEqual(6)
  })

  it("does not bill sparse prose frames at a dense tool-input call's rate", () => {
    // The reported failure: one call whose frames carried large tool-input JSON
    // taught the then-per-frame coefficient its ceiling, after which subagents
    // writing prose read ~800 tok/s while the engine log showed ~250. Learning
    // is per character class now, so a dense latin call moves only kAscii.
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')
    const cjkBefore = meter.calibration().kCjk

    // Call 1: 6 frames, but ~2.5k latin characters and 1,320 real tokens (the
    // measured shape of a 6-subagent Agent tool call).
    meter.beginCall()
    for (let i = 0; i < 6; i++) {
      clock.advance(100)
      meter.push('{"prompt":"' + 'a'.repeat(400) + '"}')
    }
    meter.endCall(1320, 600)
    expect(meter.calibration().kAscii).toBeGreaterThan(1.5)
    // The dense latin call must not touch the CJK coefficient.
    expect(meter.calibration().kCjk).toBe(cjkBefore)

    // Call 2: the subagents' prose, four CJK characters per frame — read at
    // their own character density, not at the tool-input density.
    meter.reset()
    meter.beginCall()
    for (let i = 0; i < 10; i++) {
      clock.advance(100)
      meter.push('你好世界')
    }
    clock.advance(BUCKET)
    expect(meter.windowTokens()).toBeCloseTo(40 * cjkBefore, 5)
    expect(meter.value()).toBeCloseTo(40 * cjkBefore, 1)
  })

  it('predicts the measured mixed call instead of staying at the neutral 1.0', () => {
    // Measured on the local engine: one parent call delivered 242 CJK
    // characters of thinking, 65 of prose and a 2,464-character latin
    // tool-input blob, and the CLI reported 1,627 output tokens.
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')
    meter.beginCall()
    clock.advance(50)
    meter.push('内容是'.repeat(80) + '内容')      // 242 CJK characters
    clock.advance(50)
    meter.push('先深'.repeat(32) + '先')          // 65 CJK characters
    clock.advance(50)
    meter.push('x'.repeat(2464))                  // latin tool-input JSON
    expect(meter.endCall(1627, 4000)).toBe(true)

    const { kCjk, kAscii } = meter.calibration()
    const estimate = 307 * kCjk + (2464 / 3.5) * kAscii
    expect(estimate).toBeGreaterThan(1627 * 0.95)
    expect(estimate).toBeLessThan(1627 * 1.05)
  })

  it('separates the CJK and latin densities from mixed traffic', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')
    const PROSE = '这是一段中文说明文字，用于验证密度分离。'.repeat(3)   // 60 CJK chars
    const CODE = '{"key":"value","n":123},'.repeat(8)                  // 192 latin chars

    // Six calls alternating prose and code, with the real counts their
    // densities imply: 1 token per CJK char, 1.75 tokens per latin unit.
    for (let call = 0; call < 6; call++) {
      meter.beginCall()
      clock.advance(20)
      if (call % 2 === 0) {
        meter.push(PROSE)
        meter.endCall(60, 500)
      } else {
        meter.push(CODE)
        meter.endCall(Math.round((192 / 3.5) * 1.75), 500)
      }
      meter.reset()
    }

    const { kCjk, kAscii } = meter.calibration()
    expect(kCjk).toBeGreaterThan(0.8)
    expect(kCjk).toBeLessThan(1.2)
    expect(kAscii).toBeGreaterThan(1.5)
    expect(kAscii).toBeLessThan(2.1)
  })

  it('survives reset() with its calibration and needs a fresh call window', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')

    meter.beginCall()
    for (let i = 0; i < 30; i++) {
      clock.advance(20)
      meter.push('x'.repeat(6))
    }
    meter.endCall(60, 600)
    const learned = meter.calibration()
    expect(learned).not.toEqual({ kCjk: DEFAULT_K_CJK, kAscii: 1 })

    meter.reset()
    expect(meter.hasStreamed()).toBe(false)
    expect(meter.calibration()).toEqual(learned)
    expect(meter.windowTokens()).toBe(0)

    // A frame outside any call still counts, it just cannot teach.
    clock.advance(20)
    meter.push('x'.repeat(6))
    clock.advance(BUCKET)
    meter.push('x'.repeat(6))
    expect(meter.windowTokens()).toBeGreaterThan(0)
    expect(meter.calibration()).toEqual(learned)
  })
})

describe('aggregateMeterReadings', () => {
  function harness() {
    const clock = arrivalClock()
    return {
      clock,
      /** Interleaved so every meter's buckets sit in the same second. */
      pumpAll(meters: TpsMeter[], n = 10, text = 'x'.repeat(6)): void {
        for (let i = 0; i < n; i++) {
          clock.advance(100)
          for (const meter of meters) meter.push(text)
        }
      },
      pump(meter: TpsMeter, n = 10): void {
        this.pumpAll([meter], n)
      },
    }
  }

  const meter = (clock: TpsClock = 'arrival') => new TpsMeter(clock)

  it('adds a live subagent to the session own speed and counts it', () => {
    const h = harness()
    const own = meter()
    const sub = meter()
    h.pumpAll([own, sub])

    const single = aggregateMeterReadings(own, [], h.clock.now, 5 * 60 * 1000)
    const r = aggregateMeterReadings(own, [sub], h.clock.now, 5 * 60 * 1000)
    expect(single.tps).toBeGreaterThan(0)
    expect(r.visible).toBe(true)
    expect(r.activeSubs).toBe(1)
    // Each meter rates its own stream, so the team speed is the sum.
    expect(r.tps).toBeCloseTo(single.tps + sub.value(), 5)
    expect(r.tps).toBeCloseTo(single.tps * 2, 5)
  })

  it('sums four concurrent subagents (the four-agent dispatch case)', () => {
    const h = harness()
    const own = meter()
    const subs = [0, 1, 2, 3].map(() => meter())
    h.pumpAll([own, ...subs])

    const r = aggregateMeterReadings(own, subs, h.clock.now, 5 * 60 * 1000)
    expect(r.activeSubs).toBe(4)
    const expected = own.value() + subs.reduce((sum, sub) => sum + sub.value(), 0)
    expect(r.tps).toBeCloseTo(expected, 5)
    // Five concurrent decoders, so about five times one stream's rate.
    expect(r.tps).toBeGreaterThan(own.value() * 4.5)
  })

  it('shows the subagents alone while the session itself has not streamed', () => {
    const h = harness()
    const own = meter()
    const sub = meter()
    h.pump(sub)

    // The session is idle waiting on its subagents; their speed is still the
    // honest team reading, so it is shown rather than masked.
    const r = aggregateMeterReadings(own, [sub], h.clock.now, 5 * 60 * 1000)
    expect(r.visible).toBe(true)
    expect(r.activeSubs).toBe(1)
    expect(r.tps).toBeCloseTo(sub.value(), 5)
  })

  it('drops a finished subagent out of the sum once it has gone quiet', () => {
    const h = harness()
    const own = meter()
    const sub = meter()
    h.pump(sub)

    // The subagent stops. Past the liveness gap it no longer feeds the sum,
    // though its own value() still serves the held reading.
    h.clock.advance(10_000)
    h.pump(own)

    const r = aggregateMeterReadings(own, [sub], h.clock.now, 5 * 60 * 1000)
    expect(r.visible).toBe(true)
    expect(r.activeSubs).toBe(0)
    const single = aggregateMeterReadings(own, [], h.clock.now, 5 * 60 * 1000)
    expect(r.tps).toBeCloseTo(single.tps, 5)
  })

  it('is unchanged for a lone main session (no subordinates)', () => {
    const h = harness()
    const own = meter()
    h.pump(own)

    let r = aggregateMeterReadings(own, [], h.clock.now, 5 * 60 * 1000)
    expect(r.visible).toBe(true)
    expect(r.activeSubs).toBe(0)
    expect(r.tps).toBeCloseTo(own.value(), 5)
    expect(r.tps).toBeGreaterThan(0)

    // Once it goes quiet the aggregate falls back to the held reading.
    h.clock.advance(10_000)
    r = aggregateMeterReadings(own, [], h.clock.now, 5 * 60 * 1000)
    expect(r.visible).toBe(true)
    expect(r.tps).toBeCloseTo(own.value(), 5)
    expect(r.tps).toBeGreaterThan(0)
  })

  it('stays hidden before anything has streamed, and hides after the 5-min idle', () => {
    const h = harness()
    const own = meter()
    expect(aggregateMeterReadings(own, [], h.clock.now, 5 * 60 * 1000).visible).toBe(false)

    h.pump(own)
    expect(aggregateMeterReadings(own, [], h.clock.now, 5 * 60 * 1000).visible).toBe(true)

    h.clock.advance(6 * 60 * 1000)
    expect(aggregateMeterReadings(own, [], h.clock.now, 5 * 60 * 1000).visible).toBe(false)
  })
})

describe('a backgrounded tab: freeze, then the backlog is handed over at once', () => {
  /** Real decoding at ~104 t/s: 13 tokens per bucket. */
  const RATE = 104

  /**
   * Freeze for `ms`, then deliver everything that queued up in one instant. On
   * the arrival clock this is what a throttled tab looks like: no JS runs, so no
   * frame is placed, and the whole backlog arrives when the client finally runs
   * again — all of it inside the same 125 ms.
   */
  function freezeAndDrain(
    meter: TpsMeter,
    clock: ReturnType<typeof arrivalClock>,
    gen: { at: number },
    ms: number,
    stamped: boolean,
  ) {
    clock.advance(ms)
    for (let t = 0; t < ms; t += BUCKET) {
      if (stamped) {
        meter.pushTokens(13, { generatedAt: gen.at })
        gen.at += BUCKET
      } else {
        meter.pushTokens(13)
      }
    }
  }

  it('does not read the backlog as a burst (arrival clock)', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')
    const gen = { at: 0 }
    steady(meter, clock, 16, 13, gen)
    expect(meter.value()).toBeCloseTo(RATE, 0)

    freezeAndDrain(meter, clock, gen, 60_000, false)

    // In one bucket the 60 s backlog reads as 60×8×13/0.125 ≈ 50 000 t/s; it used
    // to be charged to a single bucket and showed as 25 012 (capped at 9999 on
    // screen) for the second it took that bucket to leave the window.
    expect(meter.value()).toBeLessThanOrEqual(RATE)

    // And it is back to the truth as soon as the window holds live frames again.
    for (let i = 0; i < 8; i++) {
      clock.advance(BUCKET)
      meter.pushTokens(13)
    }
    expect(meter.value()).toBeCloseTo(RATE, 0)
  })

  it('is already correct with generation stamps, which is why they are the default', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    steady(meter, clock, 16, 13, gen)

    freezeAndDrain(meter, clock, gen, 60_000, true)

    // Each frame carries the instant the server received it, so the backlog lands
    // across the buckets it was really generated in and never pools.
    expect(meter.value()).toBeCloseTo(RATE, 0)
    for (let i = 0; i < 8; i++) {
      clock.advance(BUCKET)
      meter.pushTokens(13, { generatedAt: gen.at })
      gen.at += BUCKET
    }
    expect(meter.value()).toBeCloseTo(RATE, 0)
  })

  it('keeps the last real speed through the silence instead of reporting zero', () => {
    const clock = arrivalClock()
    const meter = new TpsMeter('arrival')
    const gen = { at: 0 }
    steady(meter, clock, 16, 13, gen)

    // Away for two minutes; the answer finishes while we are gone, so nothing
    // follows the drain. A grid re-anchored on the drain has no window to
    // average, and reporting 0 there is not "no speed" — it is "no reading",
    // which a reader (and the indicator's anti-flash hold) then sits on.
    clock.advance(120_000)
    meter.pushTokens(13)
    meter.endStream()

    expect(meter.value()).toBeCloseTo(RATE, 0)
  })

  it('still spreads a backlog whose stall is inside the ring', () => {
    // The boundary of the rule above: content either side of the backlog means the
    // tokens do belong to a measured interval, so they are spread as before.
    const clock = arrivalClock()
    const meter = new TpsMeter('generation')
    const gen = { at: GEN_EPOCH }
    steady(meter, clock, 3, 10, gen)
    clock.advance(6 * BUCKET)
    gen.at += 6 * BUCKET
    steady(meter, clock, 1, 1200, gen)

    expect(meter.value()).toBeGreaterThan(900)
    expect(meter.value()).toBeLessThan(1250)
  })
})
