import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ActivitySettings } from './ActivitySettings'
import { useSettingsStore } from '../stores/settingsStore'

const { getStatsMock } = vi.hoisted(() => ({
  getStatsMock: vi.fn(),
}))

const {
  getPreferencesMock,
  updateProfilePreferencesMock,
  uploadProfileAvatarMock,
  deleteProfileAvatarMock,
} = vi.hoisted(() => ({
  getPreferencesMock: vi.fn(),
  updateProfilePreferencesMock: vi.fn(),
  uploadProfileAvatarMock: vi.fn(),
  deleteProfileAvatarMock: vi.fn(),
}))

vi.mock('../api/activityStats', () => ({
  activityStatsApi: {
    getStats: getStatsMock,
  },
}))

vi.mock('../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: {
    getPreferences: getPreferencesMock,
    updateProfilePreferences: updateProfilePreferencesMock,
    uploadProfileAvatar: uploadProfileAvatarMock,
    deleteProfileAvatar: deleteProfileAvatarMock,
  },
  getProfileAvatarUrl: () => '/api/desktop-ui/preferences/profile/avatar?mock=1',
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
  modelUsage: {
    'claude-sonnet': {
      inputTokens: 1_900_000,
      outputTokens: 700_000,
      cacheReadInputTokens: 230_000,
      cacheCreationInputTokens: 34_000,
    },
  },
  toolUsage: {
    Bash: 180,
    Read: 160,
    Skill: 40,
    mcp__github__get_pull_request: 14,
    mcp__chrome_devtools__new_page: 8,
    mcp__figma__get_screenshot: 7,
    mcp__linear__create_issue: 2,
  },
  skillUsage: {
    'frontend-design': 24,
    'git-commit-pr': 16,
    'code-review': 11,
  },
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
    getPreferencesMock.mockReset()
    updateProfilePreferencesMock.mockReset()
    uploadProfileAvatarMock.mockReset()
    deleteProfileAvatarMock.mockReset()
    getPreferencesMock.mockResolvedValue({
      exists: false,
      preferences: {
        schemaVersion: 2,
        profile: {
          displayName: 'cc-haha',
          subtitle: 'github.com/NanmiCoder/cc-haha',
          avatarFile: null,
          avatarUpdatedAt: null,
        },
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: [],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      },
    })
    updateProfilePreferencesMock.mockImplementation((profile) => Promise.resolve({
      ok: true,
      preferences: {
        schemaVersion: 2,
        profile: {
          displayName: profile.displayName,
          subtitle: profile.subtitle,
          avatarFile: null,
          avatarUpdatedAt: null,
        },
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: [],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      },
    }))
    uploadProfileAvatarMock.mockImplementation(() => Promise.resolve({
      ok: true,
      preferences: {
        schemaVersion: 2,
        profile: {
          displayName: 'cc-haha',
          subtitle: 'github.com/NanmiCoder/cc-haha',
          avatarFile: 'profile/avatar.png',
          avatarUpdatedAt: '2026-05-09T12:00:00.000Z',
        },
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: [],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      },
    }))
    deleteProfileAvatarMock.mockImplementation(() => Promise.resolve({
      ok: true,
      preferences: {
        schemaVersion: 2,
        profile: {
          displayName: 'cc-haha',
          subtitle: 'github.com/NanmiCoder/cc-haha',
          avatarFile: null,
          avatarUpdatedAt: null,
        },
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: [],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      },
    }))
    useSettingsStore.setState({ locale: 'en' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders summary metrics and a GitHub-style trailing heatmap without future days', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(getStatsMock).toHaveBeenCalledWith('all')

    expect(screen.getByText('cc-haha')).toBeInTheDocument()
    expect(screen.getByAltText('cc-haha avatar')).toHaveAttribute('src', '/app-icon.png')
    expect(screen.getByAltText('cc-haha avatar')).toHaveClass('scale-[1.28]')
    expect(screen.getByRole('link', { name: 'github.com/NanmiCoder/cc-haha' })).toHaveAttribute(
      'href',
      'https://github.com/NanmiCoder/cc-haha',
    )
    expect(screen.getByText('Token Activity')).toBeInTheDocument()
    expect(screen.getByText('Total tokens')).toBeInTheDocument()
    expect(screen.getByText('Peak tokens')).toBeInTheDocument()
    expect(screen.getByText('Longest task')).toBeInTheDocument()
    expect(screen.getByText('Current streak')).toBeInTheDocument()
    expect(screen.getByText('Longest streak')).toBeInTheDocument()
    expect(screen.getByText('2.9M')).toBeInTheDocument()
    expect(screen.getByText('2.7M')).toBeInTheDocument()
    expect(screen.getByText('0m')).toBeInTheDocument()
    expect(screen.getByText('9 days')).toBeInTheDocument()
    expect(screen.getByText('18 days')).toBeInTheDocument()
    expect(screen.getByText('Activity insights')).toBeInTheDocument()
    expect(screen.getByText('Active rate')).toBeInTheDocument()
    expect(screen.getByText('Most used model')).toBeInTheDocument()
    expect(screen.getByText('Skills explored')).toBeInTheDocument()
    expect(screen.getByText('Skill uses')).toBeInTheDocument()
    expect(screen.getByText('Tool calls')).toBeInTheDocument()
    expect(screen.getByText('Total sessions')).toBeInTheDocument()
    expect(screen.getByText('Most used plugins & skills')).toBeInTheDocument()
    expect(screen.getByText('Sonnet')).toBeInTheDocument()
    expect(screen.getByText('$frontend-design')).toBeInTheDocument()
    expect(screen.getByText('$git-commit-pr')).toBeInTheDocument()
    expect(screen.getByText('$code-review')).toBeInTheDocument()
    expect(screen.getByText('@github')).toBeInTheDocument()
    expect(screen.getByText('@chrome-devtools')).toBeInTheDocument()
    expect(screen.getByText('@figma')).toBeInTheDocument()
    expect(screen.getByText('24 runs')).toBeInTheDocument()
    expect(screen.getByText('14 runs')).toBeInTheDocument()
    expect(screen.getByText('7 runs')).toBeInTheDocument()
    expect(screen.queryByText('@linear')).not.toBeInTheDocument()
    expect(screen.queryByText('Bash')).not.toBeInTheDocument()
    expect(screen.queryByText('Read')).not.toBeInTheDocument()
    expect(screen.getAllByText('May').length).toBeGreaterThan(0)
    expect(screen.queryByText('5月')).not.toBeInTheDocument()
    // May 2026 starts in the final column, too late to fit its name.
    expect(screen.getByTestId('activity-month-labels').lastElementChild).toHaveTextContent('Apr')

    const todayCell = screen.getByRole('gridcell', {
      name: /May 9, 2026: 4 sessions · 128K Tokens/i,
    })
    expect(todayCell).toBeInTheDocument()
    expect(screen.queryByRole('gridcell', { name: /May 10, 2026/i })).not.toBeInTheDocument()
  })

  it('shows a compact hover preview without a persistent selected-day panel', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const todayCell = screen.getByRole('gridcell', {
      name: /May 9, 2026: 4 sessions · 128K Tokens/i,
    })

    fireEvent.mouseEnter(todayCell)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('May 9, 2026')
    expect(tooltip).toHaveTextContent('4 sessions · 128K Tokens')
    expect(tooltip).not.toHaveTextContent(/messages|tools/i)
    expect(tooltip.className).toContain('--color-activity-tooltip-surface')
    expect(tooltip.className).toContain('--color-activity-tooltip-border')
    expect(todayCell.className).toContain('activity-heat-cell')
    expect(todayCell.className).toContain('is-active')
    expect(todayCell.className).toContain('--color-activity-cell-border')
    expect(screen.queryByText('Selected day')).not.toBeInTheDocument()
  })

  it('keeps the profile edit control out of screenshots until hover or keyboard focus', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const editButton = screen.getByRole('button', { name: 'Edit profile' })
    expect(editButton).toHaveClass('opacity-0')
    expect(editButton).toHaveClass('group-hover/activity-profile:opacity-100')
    expect(editButton).toHaveClass('focus-visible:opacity-100')
    expect(editButton.closest('div')).toHaveClass('group/activity-profile')
  })

  it('lays the summary out as KPI tiles whose column count comes from the container, not the viewport', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const summaryPanel = screen.getByText('Total tokens').closest('section')
    expect(summaryPanel).toHaveClass('activity-summary-panel')
    expect(within(summaryPanel as HTMLElement).getByText('2.9M')).toBeInTheDocument()

    // Breakpoints live in container queries (globals.css), so the settings rail
    // width cannot push the tiles into a cramped row.
    const summaryGrid = summaryPanel?.querySelector('.activity-summary-grid')
    expect(summaryGrid).not.toHaveClass('sm:grid-cols-2')
    expect(summaryGrid).not.toHaveClass('lg:grid-cols-5')
    expect(summaryGrid).not.toHaveClass('xl:grid-cols-5')

    // The headline tile is the one that spans two columns; the label sits above the number.
    const primaryMetric = screen.getByText('Total tokens').closest('.activity-summary-metric')
    expect(primaryMetric).toHaveClass('activity-summary-metric-primary')
    expect(primaryMetric).not.toHaveClass('sm:col-span-2')
    expect(primaryMetric?.firstElementChild).toHaveTextContent('Total tokens')
    expect(screen.getByText('Peak tokens').closest('.activity-summary-metric')).not.toHaveClass('activity-summary-metric-primary')

    // Two lines, not one truncated line: at a third of the row a duration like
    // "436 小时 26 分钟" rendered as "436 小…". Clamping still caps the growth, so
    // the tiles stay compact.
    const longestTaskValue = screen.getByText('0m')
    expect(longestTaskValue).toHaveClass('activity-summary-value')
    expect(longestTaskValue).toHaveClass('line-clamp-2')
    expect(longestTaskValue).toHaveClass('tabular-nums')
    expect(longestTaskValue).not.toHaveClass('break-words')
  })

  it('places heatmap month labels by week without collisions or overhang', async () => {
    // The 52-week window then opens on Sunday 2024-01-28: January's last four
    // days sit in column 0 and February starts in column 1.
    vi.setSystemTime(new Date('2025-01-20T12:00:00'))
    render(<ActivitySettings />)

    await flushActivityLoad()

    const labels = Array.from(screen.getByTestId('activity-month-labels').children) as HTMLElement[]
    const texts = labels.map((label) => label.textContent)
    // January's 4-day tail would have collided with February, so it is dropped.
    expect(texts[0]).toBe('Feb')
    expect(texts).toHaveLength(12)
    expect(texts[texts.length - 1]).toBe('Jan')

    const lefts = labels.map((label) => Number.parseFloat(label.style.left))
    // February sits in column 1, so its offset is exactly one cell plus gap.
    const cellPitch = lefts[0]!
    expect(cellPitch).toBeGreaterThan(0)
    for (let index = 1; index < lefts.length; index += 1) {
      expect(lefts[index]! - lefts[index - 1]!).toBeGreaterThanOrEqual(cellPitch * 3)
    }
    // No label starts in the last two columns, where it would overhang the grid.
    expect(Math.max(...lefts)).toBeLessThanOrEqual(cellPitch * 49)
  })

  it('charts the trailing 14 days ending today and highlights only today', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const chart = screen.getByRole('list', { name: 'Token usage by day' })
    const bars = within(chart).getAllByRole('listitem')
    expect(bars).toHaveLength(14)
    expect(bars[0]).toHaveTextContent('Apr 26, 2026: 0 Tokens')
    expect(bars[11]).toHaveTextContent('May 7, 2026: 64K Tokens')
    expect(bars[13]).toHaveTextContent('May 9, 2026: 128K Tokens')
    expect(within(chart).queryByText(/May 10, 2026/)).not.toBeInTheDocument()

    const barFill = (bar: HTMLElement) => bar.firstElementChild as HTMLElement
    // Heights are relative to the window's own peak, so today's 128K fills the
    // chart and the 64K day sits at half height.
    expect(barFill(bars[13]!).style.height).toBe('100%')
    expect(barFill(bars[11]!).style.height).toBe('50%')
    expect(barFill(bars[0]!).style.height).toBe('0%')
    expect(barFill(bars[13]!).className).toContain('--color-brand')
    expect(barFill(bars[11]!).className).not.toContain('--color-brand')
  })

  it('breaks tokens and cost down per model, marking unpriced models instead of showing $0', async () => {
    getStatsMock.mockResolvedValueOnce({
      ...activityResponse,
      modelUsage: {
        'claude-sonnet': {
          inputTokens: 1_900_000,
          outputTokens: 700_000,
          cacheReadInputTokens: 230_000,
          cacheCreationInputTokens: 34_000,
          costUSD: 12.5,
        },
        'glm-4.6': {
          inputTokens: 40_000,
          outputTokens: 2_000,
          costUSD: 0,
        },
      },
      unpricedModels: ['glm-4.6'],
    })
    render(<ActivitySettings />)

    await flushActivityLoad()

    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Model',
      'New tokens',
      'Cache hits',
      'Estimated cost',
    ])
    // Sorted by total tokens, largest first.
    expect(within(rows[1]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'claude-sonnet',
      '2.6M',
      '230K',
      '$12.50',
    ])
    expect(within(rows[2]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'glm-4.6',
      '42K',
      '0',
      '—',
    ])
  })

  it('orders the page usage, then activity, then the per-model breakdown', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const usage = screen.getByRole('list', { name: 'Token usage by day' })
    const activity = screen.getByRole('heading', { name: 'Token Activity' })
    const insights = screen.getByRole('heading', { name: 'Activity insights' })
    const models = screen.getByRole('heading', { name: 'Usage by model' })
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(usage, activity)).toBe(true)
    expect(follows(activity, insights)).toBe(true)
    expect(follows(insights, models)).toBe(true)
    expect(follows(models, screen.getByRole('table'))).toBe(true)
  })

  it('supports localized heatmap mode switches and persisted display name edits', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.getByText('Token 活动')).toBeInTheDocument()
    const modeGroup = screen.getByRole('radiogroup', { name: 'Token 活动' })
    expect(within(modeGroup).getByRole('radio', { name: '每日' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(modeGroup).getByRole('radio', { name: '每周' }))
    expect(within(modeGroup).getByRole('radio', { name: '每周' })).toHaveAttribute('aria-checked', 'true')
    expect(within(modeGroup).getByRole('radio', { name: '每日' })).toHaveAttribute('aria-checked', 'false')
    // Weekly mode relabels the cells as week ranges.
    expect(screen.getAllByRole('gridcell', { name: /^2026年5月3日 - 2026年5月9日:/ }).length).toBeGreaterThan(0)
    fireEvent.click(within(modeGroup).getByRole('radio', { name: '累计' }))
    expect(within(modeGroup).getByRole('radio', { name: '累计' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('button', { name: '编辑个人资料' }))
    const input = screen.getByLabelText('显示名称')
    const displayName = '大厂程序员阿江的 Token 活动统计展示'
    fireEvent.change(input, { target: { value: displayName } })
    fireEvent.change(screen.getByLabelText('第二行'), { target: { value: 'relakkes.dev' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await flushActivityLoad()

    expect(updateProfilePreferencesMock).toHaveBeenCalledWith({
      displayName,
      subtitle: 'relakkes.dev',
    })
    // A long display name wraps inside the profile card instead of being cut off.
    const heading = screen.getByRole('heading', { name: displayName })
    expect(heading).toHaveClass('break-words')
    expect(heading).not.toHaveClass('truncate')
    expect(heading.parentElement).toHaveClass('min-w-0')
    expect(screen.getByRole('link', { name: 'relakkes.dev' })).toHaveAttribute('href', 'https://relakkes.dev')
  })

  it('handles avatar upload, fallback, removal, save failure, and cancel reset', async () => {
    getPreferencesMock.mockResolvedValueOnce({
      exists: true,
      preferences: {
        schemaVersion: 2,
        profile: {
          displayName: 'Local Captain',
          subtitle: 'Local workspace',
          avatarFile: 'profile/avatar.webp',
          avatarUpdatedAt: '2026-05-09T12:00:00.000Z',
        },
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: [],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      },
    })
    updateProfilePreferencesMock.mockRejectedValueOnce(new Error('display name rejected'))
    render(<ActivitySettings />)

    await flushActivityLoad()

    const avatar = screen.getByAltText('Local Captain avatar')
    expect(avatar).toHaveAttribute('src', '/api/desktop-ui/preferences/profile/avatar?mock=1')
    expect(avatar).not.toHaveClass('scale-[1.28]')
    fireEvent.error(avatar)
    expect(avatar).toHaveAttribute('src', '/app-icon.png')
    expect(avatar).toHaveClass('scale-[1.28]')

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Rejected Name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await flushActivityLoad()

    expect(screen.getByText('display name rejected')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Unsaved Name' } })
    fireEvent.change(screen.getByLabelText('Second line'), { target: { value: 'Unsaved subtitle' } })
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' })
    fireEvent.click(cancelButtons[cancelButtons.length - 1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
    expect(screen.getByLabelText('Display name')).toHaveValue('Local Captain')
    expect(screen.getByLabelText('Second line')).toHaveValue('Local workspace')

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })

    await flushActivityLoad()

    expect(uploadProfileAvatarMock).toHaveBeenCalledWith(file)
    expect(screen.getByText('Saved locally')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove avatar' }))
    await flushActivityLoad()

    expect(deleteProfileAvatarMock).toHaveBeenCalled()
    expect(screen.getByAltText('cc-haha avatar')).toHaveAttribute('src', '/app-icon.png')
  })

  it('shows localized duration details and the empty usage state', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    getStatsMock.mockResolvedValueOnce({
      ...activityResponse,
      totalSessions: 0,
      totalMessages: 0,
      activeDays: 0,
      dailyActivity: [],
      dailyModelTokens: [],
      toolUsage: {},
      skillUsage: {},
      longestSession: {
        id: 'session-1',
        startedAt: '2026-05-09T08:00:00.000Z',
        endedAt: '2026-05-09T09:30:00.000Z',
        duration: 90 * 60_000,
        messageCount: 12,
        toolCallCount: 4,
      },
      peakActivityDay: null,
      streaks: {
        currentStreak: 0,
        longestStreak: 0,
        currentStreakStart: null,
        longestStreakStart: null,
        longestStreakEnd: null,
      },
    })
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.getByText('1 小时 30 分钟')).toBeInTheDocument()
    expect(screen.getByText('12 消息')).toBeInTheDocument()
    expect(screen.getByText('暂无本地用量')).toBeInTheDocument()
    expect(screen.queryByText('活动洞察')).not.toBeInTheDocument()
  })
})
