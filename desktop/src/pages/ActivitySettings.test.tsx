import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ActivitySettings } from './ActivitySettings'
import { useSettingsStore } from '../stores/settingsStore'

const { getStatsMock } = vi.hoisted(() => ({
  getStatsMock: vi.fn(),
}))

vi.mock('../api/activityStats', () => ({
  activityStatsApi: {
    getStats: getStatsMock,
  },
}))

const activityResponse = {
  range: 'all',
  generatedAt: '2026-05-09T12:00:00.000Z',
  totalSessions: 52,
  totalMessages: 900,
  totalDays: 365,
  activeDays: 20,
  streaks: {
    currentStreak: 9,
    longestStreak: 18,
    currentStreakStart: '2026-05-01',
    longestStreakStart: '2026-03-01',
    longestStreakEnd: '2026-03-18',
  },
  dailyActivity: [
    { date: '2026-04-20', sessionCount: 38, messageCount: 420, toolCallCount: 160 },
    { date: '2026-05-07', sessionCount: 2, messageCount: 30, toolCallCount: 12 },
    { date: '2026-05-09', sessionCount: 4, messageCount: 58, toolCallCount: 21 },
  ],
  dailyModelTokens: [
    { date: '2026-04-20', tokensByModel: { 'claude-sonnet': 2_672_000 } },
    { date: '2026-05-07', tokensByModel: { 'claude-sonnet': 64_000 } },
    { date: '2026-05-09', tokensByModel: { 'claude-sonnet': 128_000 } },
  ],
  longestSession: null,
  modelUsage: {},
  firstSessionDate: '2025-06-01T10:00:00.000Z',
  lastSessionDate: '2026-05-09T11:00:00.000Z',
  peakActivityDay: '2026-04-20',
  peakActivityHour: 14,
  totalSpeculationTimeSavedMs: 0,
}

async function flushActivityLoad() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ActivitySettings', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T12:00:00'))
    getStatsMock.mockReset()
    getStatsMock.mockResolvedValue(activityResponse)
    useSettingsStore.setState({ locale: 'en' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders summary metrics and a GitHub-style trailing heatmap without future days', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(getStatsMock).toHaveBeenCalledWith('all')

    expect(screen.getByText('Token usage')).toBeInTheDocument()
    expect(screen.getByText('2025.05 - 2026.05')).toBeInTheDocument()
    expect(screen.getByText('Based on local Claude Code CLI session transcripts')).toBeInTheDocument()
    expect(screen.getByText('Yesterday')).toBeInTheDocument()
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('30 days')).toBeInTheDocument()
    expect(screen.getByText('0 tokens')).toBeInTheDocument()
    expect(screen.getByText('128K tokens')).toBeInTheDocument()
    expect(screen.getByText('2.9M tokens')).toBeInTheDocument()
    expect(screen.getAllByText('May').length).toBeGreaterThan(0)
    expect(screen.queryByText('5月')).not.toBeInTheDocument()
    expect(
      screen.getByText('Today').compareDocumentPosition(screen.getByText('Yesterday')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    const todayCell = screen.getByRole('gridcell', {
      name: /May 9, 2026: 4 sessions, 128K tokens/i,
    })
    expect(todayCell).toBeInTheDocument()
    expect(screen.queryByRole('gridcell', { name: /May 10, 2026/i })).not.toBeInTheDocument()
  })

  it('shows a compact hover preview without a persistent selected-day panel', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const todayCell = screen.getByRole('gridcell', {
      name: /May 9, 2026: 4 sessions, 128K tokens/i,
    })

    fireEvent.mouseEnter(todayCell)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('May 9, 2026')
    expect(tooltip).toHaveTextContent('4 sessions · 128K tokens')
    expect(tooltip).not.toHaveTextContent(/messages|tools/i)
    expect(tooltip.className).toContain('--color-activity-tooltip-surface')
    expect(tooltip.className).toContain('--color-activity-tooltip-border')
    expect(todayCell.className).toContain('--color-activity-cell-border')
    expect(screen.queryByText('Selected day')).not.toBeInTheDocument()
  })
})
