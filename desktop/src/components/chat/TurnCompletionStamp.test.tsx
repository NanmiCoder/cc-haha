import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TurnCompletionStamp } from './TurnCompletionStamp'
import { useSettingsStore } from '../../stores/settingsStore'
import { formatExactMessageTimestamp, formatMessageHoverTime } from '../../lib/formatMessageTimestamp'

const COMPLETED_AT = new Date('2026-07-30T07:20:41Z').getTime()

describe('TurnCompletionStamp', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('reads as a compact clock time plus how long the turn took', () => {
    render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT, durationMs: 739_000 }} />)

    const stamp = screen.getByText(formatMessageHoverTime(COMPLETED_AT, 'en'))
    expect(stamp).toBeTruthy()
    expect(screen.getByText('took 12m 19s')).toBeTruthy()
  })

  it('shows the end time alone when the duration is not trustworthy', () => {
    const { container } = render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT }} />)

    expect(screen.getByText(formatMessageHoverTime(COMPLETED_AT, 'en'))).toBeTruthy()
    expect(container.querySelector('[data-turn-completion-duration]')).toBeNull()
  })

  it('shows what the turn spent, before how long it took', () => {
    const { container } = render(
      <TurnCompletionStamp completion={{ completedAt: COMPLETED_AT, durationMs: 739_000, outputTokens: 1_500 }} />,
    )

    expect(screen.getByText('used 1.50k')).toBeTruthy()
    // Same order as the activity digest: tokens first, elapsed time last.
    const text = container.textContent ?? ''
    expect(text.indexOf('used 1.50k')).toBeLessThan(text.indexOf('took 12m 19s'))
  })

  it('omits the token total for a turn whose calls reported none', () => {
    const { container } = render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT, durationMs: 1_000 }} />)

    expect(container.querySelector('[data-turn-completion-usage]')).toBeNull()
    expect(screen.getByText('took 1s')).toBeTruthy()
  })

  it('carries the exact timestamp as a title for the rounded clock label', () => {
    render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT, durationMs: 1_000 }} />)

    expect(screen.getByText(formatMessageHoverTime(COMPLETED_AT, 'en')).getAttribute('title')).toBe(
      formatExactMessageTimestamp(COMPLETED_AT, 'en'),
    )
  })

  it('follows the active locale', () => {
    useSettingsStore.setState({ locale: 'zh' })
    const { container } = render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT, durationMs: 739_000 }} />)

    expect(container.textContent).toContain('耗时 12 分 19 秒')
  })

  it('renders nothing for an unusable timestamp', () => {
    const { container } = render(<TurnCompletionStamp completion={{ completedAt: Number.NaN }} />)

    expect(container.firstElementChild).toBeNull()
  })

  it('does not add a second row or its own hover gate', () => {
    const { container } = render(<TurnCompletionStamp completion={{ completedAt: COMPLETED_AT }} />)

    expect(container.firstElementChild?.tagName).toBe('SPAN')
    expect(container.firstElementChild?.className).not.toContain('mt-')
    expect(container.firstElementChild?.className).not.toContain('opacity-0')
    expect(container.firstElementChild?.className).not.toContain('group-hover')
  })
})
