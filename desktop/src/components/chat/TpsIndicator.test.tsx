import { cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TpsMeter } from '@/lib/tpsMeter'
import * as chatStore from '@/stores/chatStore'
import { TpsIndicator } from './TpsIndicator'

// Drive the real meters with a fake clock so the sliding windows behave
// deterministically, and stub only the store lookups.
let now = 1_000_000
const ownMeter = new TpsMeter(1500, 500)
const subMeter = new TpsMeter(1500, 500)

function pump(meter: TpsMeter, n = 10): void {
  for (let i = 0; i < n; i++) {
    now += 100
    meter.push('x'.repeat(6))
  }
}

beforeEach(() => {
  now = 1_000_000
  ownMeter.reset()
  subMeter.reset()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(chatStore, 'getSessionTpsMeter').mockReturnValue(ownMeter)
  vi.spyOn(chatStore, 'getSubordinateTpsMeters').mockReturnValue([subMeter])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('shows the aggregated total with a Σn badge while a subagent is emitting', async () => {
  pump(ownMeter)
  pump(subMeter)

  const { container } = render(<TpsIndicator sessionId="main" />)
  // The mount effect runs tick() synchronously, so the indicator has a reading.
  const indicator = container.querySelector('[data-testid="tps-indicator"]')
  expect(indicator).not.toBeNull()


  // Σ badge appears because the subagent meter is live in the window.
  expect(container.querySelector('[data-testid="tps-subagent-badge"]')).toHaveTextContent('Σ1')
  // Number rendered, and it is the combined total (> a single stream).
  const numberText = indicator!.textContent?.replace(/TPS|t\/s|Σ1/g, '').trim() ?? ''
  const shown = Number(numberText)
  expect(shown).toBeGreaterThan(0)
})

it('drops the Σ badge once the subagent stops (its held speed must not inflate the total)', async () => {
  pump(subMeter)
  // Subagent finishes; drain its 1500ms window.
  now += 10_000
  pump(ownMeter)

  const { container } = render(<TpsIndicator sessionId="main" />)
  expect(container.querySelector('[data-testid="tps-indicator"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="tps-subagent-badge"]')).toBeNull()

})

it('caps the displayed value at 4 digits (9999)', () => {
  // Relay real token counts far above the display ceiling: 15 live samples of
  // 2000 tokens over a ~1.4s window ≈ 21k tokens/s.
  for (let i = 0; i < 20; i++) {
    now += 100
    ownMeter.pushTokens(2000)
  }
  const { container } = render(<TpsIndicator sessionId="main" />)
  const indicator = container.querySelector('[data-testid="tps-indicator"]')!
  const numberText = indicator.textContent?.replace(/TPS|t\/s|Σ\d+/g, '').trim() ?? ''
  expect(Number(numberText)).toBe(9999)
  // The reading comes from the exact (relayed ids) tier, so the tooltip must
  // not advertise it as approximate.
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



