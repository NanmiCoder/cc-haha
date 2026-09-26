import { describe, expect, it, vi, afterEach } from 'vitest'
import { TpsMeter, aggregateMeterReadings, estimateTokens } from './tpsMeter'

describe('TpsMeter fallback', () => {
  afterEach(() => vi.restoreAllMocks())

  it('holds the turn-ending speed after the stream pauses', () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const meter = new TpsMeter(1500, 2000)
    expect(meter.hasStreamed()).toBe(false)
    expect(meter.value()).toBe(0)

    // Stream ~60 tokens over ~1 second.
    for (let i = 0; i < 10; i++) {
      now += 100
      meter.push('x'.repeat(6))
    }
    expect(estimateTokens('x'.repeat(6))).toBeGreaterThan(0)
    expect(meter.hasStreamed()).toBe(true)

    const live = meter.value()
    expect(live).toBeGreaterThan(0)

    // Simulate turn end: no more pushes, window drains (advance 10s).
    now += 10_000
    const held = meter.value()
    // Fallback should still be > 0 (not dropped to 0).
    expect(held).toBeGreaterThan(0)
  })

  it('does not collapse to 0 on a sparse boundary sample', () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const meter = new TpsMeter(1500, 2000)
    // Steady stream first so the fallback has a meaningful speed.
    for (let i = 0; i < 20; i++) {
      now += 50
      meter.push('x'.repeat(6))
    }
    const baseline = meter.value()
    expect(baseline).toBeGreaterThan(0)

    // Stream boundary: a single tiny fragment lands (e.g. tool-input start),
    // then the window prunes the old bulk samples.
    now += 1600 // evict previous samples from the 1500ms window
    meter.push('{')
    // Only one ~1-token sample in the window now.
    const boundary = meter.value()
    // Must NOT read ~0: hold the smoothed fallback instead.
    expect(boundary).toBeGreaterThan(0.5)
  })

  it('skips the last 0.35s when computing the fallback average', () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const meter = new TpsMeter(1500, 2000)
    // Steady decode: 6 chars (≈1.7 tokens) every 100ms over 2s.
    for (let i = 0; i < 20; i++) {
      now += 100
      meter.push('x'.repeat(6))
    }
    const steady = meter.value()
    expect(steady).toBeGreaterThan(0)

    // Simulate a stream-switch burn: a long silent gap (0.6s) with no samples.
    now += 600
    // value() with an empty live window must fall back to a non-zero average
    // rather than 0 — the switch overhead is absorbed by the skip window.
    const heldAfterGap = meter.value()
    expect(heldAfterGap).toBeGreaterThan(0)
  })

  it('estimates tokens: CJK 1:1, full-width punctuation counted, ASCII 1:3.5, whitespace free', () => {
    // 4 CJK chars + 1 full-width comma → 5 tokens.
    expect(estimateTokens('你好世界，')).toBeCloseTo(5, 5)
    // 7 ASCII chars → 2 tokens (7 / 3.5).
    expect(estimateTokens('abcdefg')).toBeCloseTo(2, 5)
    // Whitespace and newlines carry no tokens of their own.
    expect(estimateTokens('a b\nc')).toBeCloseTo(3 / 3.5, 5)
    // Empty / whitespace-only input never over-counts.
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   \n\t')).toBe(0)
  })
})

describe('real-token accounting', () => {
  afterEach(() => vi.restoreAllMocks())

  function clock(start = 1_000_000) {
    const ref = { now: start }
    vi.spyOn(performance, 'now').mockImplementation(() => ref.now)
    return ref
  }

  it('sums relayed token ids exactly and ignores the duplicated text frames', () => {
    const ref = clock()
    const meter = new TpsMeter(1500, 500)

    // The sidecar relays the engine's real token counts for the same tokens the
    // text frames carry; only the counts may reach the window.
    for (let i = 0; i < 10; i++) {
      ref.now += 100
      meter.pushTokens(3)
    }
    expect(meter.source()).toBe('ids')
    // 30 tokens over the 900ms span the samples occupy.
    expect(meter.windowTokens()).toBeCloseTo(30, 5)
    expect(meter.value()).toBeCloseTo(30 / 0.9, 1)
  })

  it('learns from the real usage so the window matches the real token total', () => {
    const ref = clock()
    const meter = new TpsMeter(1500, 500)

    // The text is latin, so before learning the neutral 1.0 coefficient
    // under-reads the real 60 tokens (6 chars = 1.71 units, not 2 tokens)…
    meter.beginCall()
    for (let i = 0; i < 30; i++) {
      ref.now += 50
      meter.push('x'.repeat(6))
    }
    expect(meter.windowTokens()).toBeLessThan(55)

    // …and the real usage from that call teaches the coefficients.
    meter.endCall(60, 1500)

    // Fresh window for the next call (calibration is kept across reset()).
    meter.reset()
    meter.beginCall()
    for (let i = 0; i < 30; i++) {
      ref.now += 50
      meter.push('x'.repeat(6))
    }
    expect(meter.windowTokens()).toBeCloseTo(60, 5)
  })

  it('weights a whole-block delivery by its text instead of counting it as one frame', () => {
    const ref = clock()
    const meter = new TpsMeter(1500, 500)

    meter.beginCall()
    ref.now += 100
    meter.push('你好世界', { wholeBlock: true })
    meter.endCall(4, 100)
    // 4 CJK chars == 4 tokens; a frame count would have read 1.
    expect(meter.windowTokens()).toBeCloseTo(4, 5)
  })

  it('anchors the held speed to the real decode rate when the call ends', () => {
    const ref = clock()
    const meter = new TpsMeter(1500, 500)

    const before = meter.calibration()
    meter.beginCall()
    ref.now += 20
    meter.push('x'.repeat(6))
    meter.endCall(120, 2000)
    // One frame is too small a sample to settle a coefficient…
    expect(meter.calibration()).toEqual(before)

    // …but it still anchors the held speed to the real decode rate.
    ref.now += 10_000
    expect(meter.value()).toBeCloseTo(120 / 2, 5)
  })

  it('rejects a ballooned call (replayed prefix) and clamps the coefficients', () => {
    const ref = clock()
    const meter = new TpsMeter(1500, 500)
    meter.setCalibration({ kCjk: 1, kAscii: 1 })

    // Establish a normal call size first (100 latin frames ≈ 171 units).
    meter.beginCall()
    for (let i = 0; i < 100; i++) { ref.now += 5; meter.push('x'.repeat(6)) }
    meter.endCall(100, 2000)
    const baseline = meter.calibration().kAscii

    // A fallback replay delivers the whole prefix again as one huge unit count.
    meter.beginCall()
    for (let i = 0; i < 1000; i++) { ref.now += 1; meter.push('x'.repeat(6)) }
    meter.endCall(100, 2000)
    expect(meter.calibration().kAscii).toBe(baseline)

    // A genuine extreme ratio still lands inside the clamp.
    meter.beginCall()
    for (let i = 0; i < 100; i++) { ref.now += 5; meter.push('x'.repeat(6)) }
    meter.endCall(100_000, 2000)
    expect(meter.calibration().kAscii).toBeLessThanOrEqual(6)
  })

  it('does not bill sparse prose frames at a dense tool-input call\'s rate', () => {
    // The reported failure: one call whose frames carried large tool-input
    // JSON taught the then-per-frame coefficient its ceiling, after which six
    // subagents writing prose — sparse frames — read ~800 tok/s while the
    // engine log showed ~250. Learning is per character class now, so the
    // dense latin call moves only kAscii and CJK prose is untouched by it.
    const ref = clock()
    const meter = new TpsMeter(1500, 500)

    // Call 1: 6 frames, but ~2.5k latin characters and 1,320 real tokens
    // (the measured shape of a 6-subagent Agent tool call).
    meter.beginCall()
    for (let i = 0; i < 6; i++) {
      ref.now += 100
      meter.push('{"prompt":"' + 'a'.repeat(400) + '"}')
    }
    meter.endCall(1320, 600)
    expect(meter.calibration().kAscii).toBeGreaterThan(1.5)
    // The dense latin call must not touch the CJK coefficient.
    expect(meter.calibration().kCjk).toBe(1)

    // Call 2: the subagents' prose. Four CJK characters per frame, so four
    // tokens per frame — read as such, not at the tool-input density.
    meter.reset()
    meter.beginCall()
    for (let i = 0; i < 10; i++) {
      ref.now += 100
      meter.push('你好世界')
    }
    expect(meter.windowTokens()).toBeCloseTo(40, 5)
    expect(meter.value()).toBeCloseTo(40 / 0.9, 1)
  })

  it('predicts the measured mixed call instead of staying at the neutral 1.0', () => {
    // Measured on the local vLLM+DFlash engine: one parent call delivered 242
    // CJK characters of thinking, 65 of prose and a 2,464-character latin
    // tool-input blob, and the CLI reported 1,627 output tokens. The single
    // coefficient a mixed call supports reproduces that within a few percent
    // (the per-class solution needs a second call with a different mix).
    const ref = clock()
    const meter = new TpsMeter(1500, 500)
    meter.beginCall()
    ref.now += 50
    meter.push('内容是'.repeat(80) + '内容')      // 242 CJK characters
    ref.now += 50
    meter.push('先深'.repeat(32) + '先')          // 65 CJK characters
    ref.now += 50
    meter.push('x'.repeat(2464))                  // latin tool-input JSON
    expect(meter.endCall(1627, 4000)).toBe(true)

    const { kCjk, kAscii } = meter.calibration()
    const estimate = 307 * kCjk + (2464 / 3.5) * kAscii
    expect(estimate).toBeGreaterThan(1627 * 0.95)
    expect(estimate).toBeLessThan(1627 * 1.05)
  })

  it('separates the CJK and latin densities from mixed traffic', () => {
    const ref = clock()
    const meter = new TpsMeter(1500, 500)
    const PROSE = '这是一段中文说明文字，用于验证密度分离。'.repeat(3)   // 60 CJK chars
    const CODE = '{"key":"value","n":123},'.repeat(8)                  // 192 latin chars

    // Six calls alternating prose and code, with the real counts their
    // densities imply: 1 token per CJK char, 1.75 tokens per latin unit.
    for (let call = 0; call < 6; call++) {
      meter.beginCall()
      ref.now += 20
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
    const ref = clock()
    const meter = new TpsMeter(1500, 500)

    meter.beginCall()
    for (let i = 0; i < 30; i++) {
      ref.now += 20
      meter.push('x'.repeat(6))
    }
    meter.endCall(60, 600)
    const learned = meter.calibration()
    expect(learned).not.toEqual({ kCjk: 1, kAscii: 1 })

    meter.reset()
    expect(meter.hasStreamed()).toBe(false)
    expect(meter.calibration()).toEqual(learned)
    expect(meter.windowTokens()).toBe(0)

    // A frame outside any call still counts, it just cannot teach.
    ref.now += 20
    meter.push('x'.repeat(6))
    expect(meter.windowTokens()).toBeGreaterThan(0)
    expect(meter.calibration()).toEqual(learned)
  })
})

describe('aggregateMeterReadings', () => {
  afterEach(() => vi.restoreAllMocks())

  // Push a steady ~60 tok/s stream into `meter` while advancing the fake clock.
  function pump(meter: TpsMeter, nowRef: { t: number }, n = 10): void {
    for (let i = 0; i < n; i++) {
      nowRef.t += 100
      meter.push('x'.repeat(6))
    }
  }

  it('reports the own meter without re-adding subordinate speed, and counts active subs', () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const own = new TpsMeter(1500, 500)
    const sub = new TpsMeter(1500, 500)
    const ref = { t: now }
    pump(own, ref)
    pump(sub, ref) // both still inside the 1500ms window → both live

    const r = aggregateMeterReadings(own, [sub], now, 5 * 60 * 1000)
    expect(r.visible).toBe(true)
    expect(r.activeSubs).toBe(1)
    // The parent meter already carries the subagent's relayed tokens
    // (chatStore ingestSubagentTps), so the subordinate meter is a count
    // source only — adding its speed would double the reported rate.
    const single = aggregateMeterReadings(own, [], now, 5 * 60 * 1000)
    expect(r.tps).toBeCloseTo(single.tps, 5)
  })

  it('stays hidden when only a subordinate has streamed', () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const own = new TpsMeter(1500, 500)
    const sub = new TpsMeter(1500, 500)
    const ref = { t: now }
    pump(sub, ref)

    // Nothing is folded into the displayed meter yet, so there is no rate to
    // show — masking it is better than flashing a number the user cannot trace.
    const r = aggregateMeterReadings(own, [sub], now, 5 * 60 * 1000)
    expect(r.visible).toBe(false)
    expect(r.tps).toBe(0)
  })

  it('excludes a subagent whose window has drained (finished, held value must not leak)', () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const own = new TpsMeter(1500, 500)
    const sub = new TpsMeter(1500, 500)
    const ref = { t: now }
    pump(sub, ref)

    // Sub stops; advance 10s so its 1500ms window drains (held speed stays
    // non-zero via its own fallback, but it is no longer "live").
    now += 10_000
    pump(own, ref) // own is freshly emitting

    const r = aggregateMeterReadings(own, [sub], now, 5 * 60 * 1000)
    expect(r.visible).toBe(true)
    expect(r.activeSubs).toBe(0)
    // Must equal own-only (no inflated contribution from the drained sub).
    const single = aggregateMeterReadings(own, [], now, 5 * 60 * 1000)
    expect(r.tps).toBeCloseTo(single.tps, 5)
  })

  it('is unchanged for a lone main session (no subordinates)', () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const own = new TpsMeter(1500, 500)
    const ref = { t: now }
    pump(own, ref)

    // Live: aggregate === own live value, activeSubs 0.
    let r = aggregateMeterReadings(own, [], now, 5 * 60 * 1000)
    expect(r.visible).toBe(true)
    expect(r.activeSubs).toBe(0)
    expect(r.tps).toBeCloseTo(own.value(), 5)

    // After the window drains, aggregate falls back to own held speed.
    now += 10_000
    r = aggregateMeterReadings(own, [], now, 5 * 60 * 1000)
    expect(r.visible).toBe(true)
    expect(r.tps).toBeCloseTo(own.value(), 5)
  })

  it('stays hidden before anything has streamed, and hides after the 5-min idle', () => {
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const own = new TpsMeter(1500, 500)
    expect(aggregateMeterReadings(own, [], now, 5 * 60 * 1000).visible).toBe(false)

    const ref = { t: now }
    pump(own, ref)
    expect(aggregateMeterReadings(own, [], now, 5 * 60 * 1000).visible).toBe(true)

    // 5-min idle: even though the window is drained, nothing new arrived.
    now += 6 * 60 * 1000
    expect(aggregateMeterReadings(own, [], now, 5 * 60 * 1000).visible).toBe(false)
  })
})
