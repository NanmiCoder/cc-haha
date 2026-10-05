import { act, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getLiveStatus = vi.hoisted(() => vi.fn())

vi.mock('../../api/sessions', () => ({
  sessionsApi: { getLiveStatus },
}))

import { LIVE_ACTIVITY_POLL_MS, useLiveSessionActivity } from './useLiveSessionActivity'

function Probe({ enabled = true }: { enabled?: boolean }) {
  const activity = useLiveSessionActivity(enabled)
  return <div data-testid="activity">{[...activity].map(([id, state]) => `${id}=${state}`).join(',')}</div>
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useLiveSessionActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getLiveStatus.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('polls the server and follows its answer', async () => {
    getLiveStatus
      .mockResolvedValueOnce({ sessions: [{ id: 'a', activityState: 'running' }] })
      .mockResolvedValueOnce({ sessions: [{ id: 'a', activityState: 'waiting' }] })
    render(<Probe />)

    await flush()
    expect(screen.getByTestId('activity')).toHaveTextContent('a=running')

    await act(async () => { vi.advanceTimersByTime(LIVE_ACTIVITY_POLL_MS) })
    await flush()
    expect(screen.getByTestId('activity')).toHaveTextContent('a=waiting')
  })

  it('keeps the last answer when one poll fails', async () => {
    getLiveStatus
      .mockResolvedValueOnce({ sessions: [{ id: 'a', activityState: 'waiting' }] })
      .mockRejectedValueOnce(new Error('network'))
    render(<Probe />)
    await flush()

    await act(async () => { vi.advanceTimersByTime(LIVE_ACTIVITY_POLL_MS) })
    await flush()

    expect(getLiveStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('activity')).toHaveTextContent('a=waiting')
  })

  it('does not poll while disabled', async () => {
    render(<Probe enabled={false} />)
    await act(async () => { vi.advanceTimersByTime(LIVE_ACTIVITY_POLL_MS * 3) })
    expect(getLiveStatus).not.toHaveBeenCalled()
  })
})
