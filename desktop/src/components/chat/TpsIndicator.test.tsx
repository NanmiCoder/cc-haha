import { act, cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TpsMeter } from '@/lib/tpsMeter'
import * as chatStore from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { TpsIndicator, formatTps } from './TpsIndicator'

// Drive the real meters with a fake clock so the sliding windows behave
// deterministically, and stub only the store lookups.
let now = 1_000_000
const ownMeter = new TpsMeter('arrival')
const subMeter = new TpsMeter('arrival')

function pump(meter: TpsMeter, n = 10): void {
  for (let i = 0; i < n; i++) {
    now += 100
    meter.push('x'.repeat(6))
  }
}

/**
 * Concurrent decoders: every meter gets a sample at the same instant, so they
 * all sit inside one sliding window. `pump`-ing them one after another advances
 * the clock 1s per meter, which drains the earlier ones.
 */
function pumpConcurrent(meters: TpsMeter[], n = 10): void {
  for (let i = 0; i < n; i++) {
    now += 100
    for (const meter of meters) meter.push('x'.repeat(6))
  }
}

beforeEach(() => {
  now = 1_000_000
  ownMeter.reset()
  subMeter.reset()
  useSettingsStore.setState({ sessionExtendedInfo: true })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(chatStore, 'getSessionTpsMeter').mockReturnValue(ownMeter)
  vi.spyOn(chatStore, 'getAgentRunTpsMeters').mockReturnValue([subMeter])
  vi.spyOn(chatStore, 'getAgentRunTpsMeter').mockReturnValue(subMeter)
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ sessionExtendedInfo: true })
  vi.restoreAllMocks()
})

/** The number the indicator renders, as a number. */
function shownTps(container: HTMLElement): number {
  const text = container.querySelector('[data-testid="tps-indicator"]')?.textContent ?? ''
  return Number(text.replace(/[^0-9.]/g, ''))
}

it('shows the session and its subagents added together, with no badge', async () => {
  pump(ownMeter)
  pump(subMeter)

  const { container } = render(<TpsIndicator sessionId="main" />)
  // The mount effect runs tick() synchronously, so the indicator has a reading.
  const indicator = container.querySelector('[data-testid="tps-indicator"]')
  expect(indicator).not.toBeNull()
  // The Σ badge is gone: the reading is already the team total, and the count
  // it used to show was permanently zero for background runs.
  expect(container.querySelector('[data-testid="tps-subagent-badge"]')).toBeNull()
  // Two live streams of equal rate, so the total is twice one of them.
  const shown = shownTps(container)
  expect(shown).toBeGreaterThan(0)
  expect(shown).toBeCloseTo(ownMeter.value() + subMeter.value(), 0)
  expect(shown).toBeGreaterThan(ownMeter.value())
})

it('adds each live subagent, and the count shows in the tooltip only', async () => {
  const extras = [new TpsMeter('arrival'), new TpsMeter('arrival'), new TpsMeter('arrival')]
  const runs = [subMeter, ...extras]
  pumpConcurrent([ownMeter, ...runs])
  vi.spyOn(chatStore, 'getAgentRunTpsMeters').mockReturnValue(runs)

  const { container } = render(<TpsIndicator sessionId="main" />)
  const indicator = container.querySelector('[data-testid="tps-indicator"]')!
  expect(container.querySelector('[data-testid="tps-subagent-badge"]')).toBeNull()
  expect(indicator.getAttribute('title')).toContain('4')
  expect(shownTps(container)).toBeCloseTo(
    ownMeter.value() + runs.reduce((sum, meter) => sum + meter.value(), 0),
    0,
  )
})

it('drops a finished subagent out of the total once its window drains', async () => {
  pump(subMeter)
  // Subagent finishes; drain its 1500ms window.
  now += 10_000
  pump(ownMeter)

  const { container } = render(<TpsIndicator sessionId="main" />)
  expect(container.querySelector('[data-testid="tps-indicator"]')).not.toBeNull()
  // The held speed of the finished run must not inflate the total.
  expect(shownTps(container)).toBeCloseTo(ownMeter.value(), 0)
})

it('run mode shows one run own speed, ignoring its siblings', () => {
  pump(ownMeter)
  pump(subMeter)
  const { container } = render(<TpsIndicator sessionId="main" runAgentId="run-1" />)
  // Run mode resolves the run's own meter and aggregates nothing.
  expect(shownTps(container)).toBeCloseTo(subMeter.value(), 0)
})

it('picks up subagents dispatched after the indicator mounted', async () => {
  vi.useFakeTimers()
  try {
    pump(ownMeter)
    // The common case: the indicator mounts with the session and the agents are
    // dispatched afterwards. A subordinate list resolved once at mount would be
    // permanently empty here, so the total would never include the runs.
    vi.spyOn(chatStore, 'getAgentRunTpsMeters').mockReturnValue([])
    const { container } = render(<TpsIndicator sessionId="main" />)
    expect(shownTps(container)).toBeCloseTo(ownMeter.value(), 0)

    // A run starts decoding; the next poll has to see it.
    pumpConcurrent([ownMeter, subMeter])
    vi.spyOn(chatStore, 'getAgentRunTpsMeters').mockReturnValue([subMeter])
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    expect(shownTps(container)).toBeCloseTo(ownMeter.value() + subMeter.value(), 0)
  } finally {
    vi.useRealTimers()
  }
})

it('caps the displayed value at 4 digits (9999)', () => {
  // Asserted on the formatter, not through the meter: a rate that high cannot
  // come out of the meter any more, because a sample carrying more tokens than
  // any real decode could produce in its interval is treated as a batch and left
  // out (that rule is what stopped the 1600+ t/s readings). The cap stays as the
  // display's own guarantee for any source.
  expect(formatTps(21_000)).toBe('9999')
  expect(formatTps(9999)).toBe('9999')
  expect(formatTps(250)).toBe('250')
})

it('reports an exact (ids) reading without the approximate mark', () => {
  // A plausible stream from the exact tier: 50 tokens per 200 ms flush = 250 t/s.
  for (let i = 0; i < 20; i++) {
    now += 200
    ownMeter.pushTokens(50)
  }
  const { container } = render(<TpsIndicator sessionId="main" />)
  const indicator = container.querySelector('[data-testid="tps-indicator"]')!
  expect(indicator).toHaveAttribute('data-tps-source', 'ids')
  expect(indicator).not.toHaveAttribute('title', expect.stringContaining('≈'))
})

it('marks a sampled (non-ids) reading as approximate', () => {
  pump(ownMeter)
  const { container } = render(<TpsIndicator sessionId="main" />)
  const indicator = container.querySelector('[data-testid="tps-indicator"]')!
  expect(indicator).toHaveAttribute('data-tps-source', 'char')
  expect(indicator).toHaveAttribute('title', expect.stringContaining('≈'))
})

it('stays hidden before anything has streamed', () => {
  const { container } = render(<TpsIndicator sessionId="main" />)
  expect(container.querySelector('[data-testid="tps-indicator"]')).toBeNull()
})

it('renders nothing when session extended info is off, even with a live reading', () => {
  pump(ownMeter)
  useSettingsStore.setState({ sessionExtendedInfo: false })
  const { container } = render(<TpsIndicator sessionId="main" />)
  expect(container.querySelector('[data-testid="tps-indicator"]')).toBeNull()
})

it('survives the extended-info switch being flipped while mounted', () => {
  pump(ownMeter)
  const { container } = render(<TpsIndicator sessionId="main" />)
  expect(container.querySelector('[data-testid="tps-indicator"]')).not.toBeNull()

  // The switch is resolved before the effect but acted on after it, because an
  // early return above the hook would make this component call a different
  // number of hooks per render — which React rejects outright. So flipping it
  // live has to hide the indicator without throwing.
  act(() => { useSettingsStore.setState({ sessionExtendedInfo: false }) })
  expect(container.querySelector('[data-testid="tps-indicator"]')).toBeNull()

  // Flipping it back brings the reading back without a remount.
  act(() => { useSettingsStore.setState({ sessionExtendedInfo: true }) })
  expect(container.querySelector('[data-testid="tps-indicator"]')).not.toBeNull()
})




it('holds the previous number across a momentary dip, but not past the hold window', async () => {
  vi.useFakeTimers()
  try {
    // Fake timers take over `performance.now` too, so drive the clock the meter
    // reads explicitly — the indicator's hold window is measured on it as well.
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    pump(ownMeter)
    const live = ownMeter.value()
    expect(live).toBeGreaterThan(0.5)

    const { container } = render(<TpsIndicator sessionId="main" />)
    expect(shownTps(container)).toBeCloseTo(live, 0)

    // A boundary (text↔thinking↔tool): the window reads ~nothing for a moment
    // while decoding has not stopped, so the last number stands instead of
    // flashing 0. Liveness is untouched, which is what keeps the reading shown.
    vi.spyOn(ownMeter, 'value').mockReturnValue(0)
    now += 300
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(shownTps(container)).toBeCloseTo(live, 0)

    // Held *forever* would leave the digits frozen on a speed the stream no longer
    // has — the "reading stuck, never moves" failure. Past the window, a sustained
    // near-zero is a real (very slow) rate and is taken at face value.
    now += 2000
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(shownTps(container)).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
