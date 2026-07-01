import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
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
          subtitle: 'github.com/706412584/cc-haha',
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
          subtitle: 'github.com/706412584/cc-haha',
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
          subtitle: 'github.com/706412584/cc-haha',
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
    expect(screen.getByRole('link', { name: 'github.com/706412584/cc-haha' })).toHaveAttribute(
      'href',
      'https://github.com/706412584/cc-haha',
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

  it('uses a compact summary strip instead of the loose card layout', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const summaryPanel = screen.getByText('Total tokens').closest('section')
    expect(summaryPanel).toHaveClass('activity-summary-panel')
    expect(summaryPanel).toHaveClass('max-w-[900px]')

    const summaryGrid = summaryPanel?.querySelector('.activity-summary-grid')
    expect(summaryGrid).not.toHaveClass('sm:grid-cols-2')
    expect(summaryGrid).not.toHaveClass('lg:grid-cols-5')
    expect(summaryGrid).not.toHaveClass('xl:grid-cols-5')

    const primaryMetric = screen.getByText('Total tokens').closest('.activity-summary-metric')
    expect(primaryMetric).toHaveClass('activity-summary-metric-primary')
    expect(primaryMetric).not.toHaveClass('sm:col-span-2')
    expect(primaryMetric).not.toHaveClass('lg:col-span-1')
    expect(primaryMetric).toHaveClass('text-center')

    const longestTaskValue = screen.getByText('0m')
    expect(longestTaskValue).toHaveClass('activity-summary-value')
    expect(longestTaskValue).toHaveClass('truncate')
    expect(longestTaskValue).not.toHaveClass('break-words')
  })

  it('supports localized heatmap mode switches and persisted display name edits', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.getByText('Token 活动')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '每周' }))
    expect(screen.getByRole('button', { name: '每周' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '累计' }))
    expect(screen.getByRole('button', { name: '累计' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: '编辑个人资料' }))
    const input = screen.getByLabelText('显示名称')
    fireEvent.change(input, { target: { value: '本地舰长' } })
    fireEvent.change(screen.getByLabelText('第二行'), { target: { value: 'relakkes.dev' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await flushActivityLoad()

    expect(updateProfilePreferencesMock).toHaveBeenCalledWith({
      displayName: '本地舰长',
      subtitle: 'relakkes.dev',
    })
    expect(screen.getByText('本地舰长')).toBeInTheDocument()
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
