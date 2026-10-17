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

  it('shows who this is and the lifetime total in English units', async () => {
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
    // 2,672,000 + 64,000 + 128,000 tokens.
    expect(screen.getByTestId('token-total-value')).toHaveTextContent('2.9')
    expect(screen.getByTestId('token-total-unit')).toHaveTextContent('M')
    expect(screen.getByText(/Total tokens · 20 active days/)).toBeInTheDocument()
    // The exact figure and the other family's notation are one hover away.
    expect(screen.getByTestId('token-total-value').closest('[title]')).toHaveAttribute('title', '2,864,000 · 286万')
  })

  it('counts in 万 for Chinese readers and keeps the exact figure on hover', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.getByTestId('token-total-value')).toHaveTextContent('286')
    expect(screen.getByTestId('token-total-unit')).toHaveTextContent('万')
    expect(screen.getByTestId('token-total-value').closest('[title]')).toHaveAttribute('title', '2,864,000 · 2.9M')
  })

  it('summarises the run as four plain figures', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const row = screen.getByText('Longest task').closest('dl') as HTMLElement
    expect(within(row).getByText('0m')).toBeInTheDocument()
    expect(within(row).getByText('9 days')).toBeInTheDocument()
    expect(within(row).getByText('18 days')).toBeInTheDocument()
    expect(within(row).getByText('52 sessions')).toBeInTheDocument()
    // 230k of 2.86M tokens were cache reads; the rest the model processed fresh.
    expect(within(row).getByText('Cache hit rate')).toBeInTheDocument()
    expect(within(row).getByText('8%')).toBeInTheDocument()
    expect(within(row).getByText('2.6M new')).toBeInTheDocument()
  })

  it('draws the stream of the last 90 days by model and labels the real peak', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const chart = screen.getByRole('img', { name: 'Daily tokens by model, last 90 days' })
    expect(chart.querySelectorAll('path')).toHaveLength(1)
    expect(chart.querySelector('path')).toHaveAttribute('fill', 'var(--color-series-1)')
    // One hover target per day, each naming its date and exact amount.
    const titles = Array.from(chart.querySelectorAll('rect > title')).map((node) => node.textContent)
    expect(titles).toHaveLength(90)
    expect(titles[titles.length - 1]).toBe('May 9, 2026 · 128k Tokens (128,000)')
    expect(screen.getByTestId('stream-peak')).toHaveTextContent('Peak 2.7M · 4/20')
    expect(screen.getByText('Sonnet', { selector: 'li span' })).toBeInTheDocument()
  })

  it('shows the mix per model, marking unpriced models instead of showing $0', async () => {
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
        'glm-4.6': { inputTokens: 40_000, outputTokens: 2_000, costUSD: 0 },
      },
      unpricedModels: ['glm-4.6'],
    })
    render(<ActivitySettings />)

    await flushActivityLoad()

    const rows = within(screen.getByRole('table', { name: 'Usage by model' })).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Model',
      'Tokens',
      'Estimated cost',
    ])
    // Largest first; each row has its own series color.
    expect(within(rows[1]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Sonnet', '99%', '2.9M', '$12.50'])
    expect(within(rows[2]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['GLM 4.6', '1.4%', '42k', '—'])
    expect(rows[1]!.querySelector('[aria-hidden="true"] span')).toHaveStyle({ background: 'var(--color-series-1)' })
    expect(screen.getByText('Excludes 1 unpriced models')).toBeInTheDocument()
  })

  it('folds a sixth model into "Other models" so no color is shared', async () => {
    const modelUsage = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`model-${index}`, { inputTokens: (6 - index) * 1000, outputTokens: 0 }]),
    )
    getStatsMock.mockResolvedValueOnce({ ...activityResponse, modelUsage })
    render(<ActivitySettings />)

    await flushActivityLoad()

    const rows = within(screen.getByRole('table', { name: 'Usage by model' })).getAllByRole('row')
    expect(rows).toHaveLength(6)
    const last = within(rows[5]!).getAllByRole('cell')
    expect(last[0]).toHaveTextContent('Other models')
    expect(last[2]).toHaveTextContent('3k')
  })

  it('lists the most used skills and connectors', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.getByText('Most used plugins & skills')).toBeInTheDocument()
    expect(screen.getByText('$frontend-design')).toBeInTheDocument()
    expect(screen.getByText('@github')).toBeInTheDocument()
    expect(screen.getByText('@chrome-devtools')).toBeInTheDocument()
    expect(screen.getByText('24 runs')).toBeInTheDocument()
    expect(screen.queryByText('@linear')).not.toBeInTheDocument()
    expect(screen.queryByText('Bash')).not.toBeInTheDocument()
  })

  it('orders the page: identity, stream, figures, activity, models', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const hero = screen.getByTestId('token-total-value')
    const stream = screen.getByRole('img', { name: 'Daily tokens by model, last 90 days' })
    const figures = screen.getByText('Longest task')
    const activity = screen.getByRole('heading', { name: 'Token Activity' })
    const models = screen.getByRole('heading', { name: 'Model details' })
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(hero, stream)).toBe(true)
    expect(follows(stream, figures)).toBe(true)
    expect(follows(figures, activity)).toBe(true)
    expect(follows(activity, models)).toBe(true)
  })

  it('renders a GitHub-style trailing heatmap of dots without future days', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.getAllByText('May').length).toBeGreaterThan(0)
    expect(screen.queryByText('5月')).not.toBeInTheDocument()
    // May 2026 starts in the final column, too late to fit its name.
    expect(screen.getByTestId('activity-month-labels').lastElementChild).toHaveTextContent('Apr')

    const todayCell = screen.getByRole('gridcell', { name: /May 9, 2026: 4 sessions · 128k Tokens/i })
    expect(todayCell).toHaveClass('rounded-full')
    // A busy day fills its cell; a quiet one is a smaller dot.
    const quietCell = screen.getByRole('gridcell', { name: /May 8, 2026: 0 sessions · 0 Tokens/i })
    expect(Number(todayCell.style.getPropertyValue('--dot-scale'))).toBeGreaterThan(Number(quietCell.style.getPropertyValue('--dot-scale')))
    expect(screen.queryByRole('gridcell', { name: /May 10, 2026/i })).not.toBeInTheDocument()
  })

  it('shows a compact hover preview without a persistent selected-day panel', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const todayCell = screen.getByRole('gridcell', { name: /May 9, 2026: 4 sessions · 128k Tokens/i })

    fireEvent.mouseEnter(todayCell)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('May 9, 2026')
    expect(tooltip).toHaveTextContent('4 sessions · 128k Tokens')
    expect(tooltip).not.toHaveTextContent(/messages|tools/i)
    expect(tooltip.className).toContain('--color-activity-tooltip-surface')
    expect(todayCell.className).toContain('activity-heat-cell')
    expect(todayCell.className).toContain('is-active')
    expect(screen.queryByText('Selected day')).not.toBeInTheDocument()
  })

  it('keeps the profile edit control out of screenshots until hover or keyboard focus', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    const editButton = screen.getByRole('button', { name: 'Edit profile' })
    expect(editButton).toHaveClass('opacity-0')
    expect(editButton).toHaveClass('group-hover/activity-profile:opacity-100')
    expect(editButton).toHaveClass('focus-visible:opacity-100')
    expect(editButton.closest('.group\\/activity-profile')).not.toBeNull()
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
    // A long display name wraps beside the avatar instead of being cut off.
    const heading = screen.getByRole('heading', { name: displayName })
    expect(heading).toHaveClass('break-words')
    expect(heading).not.toHaveClass('truncate')
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

  it('shows localized duration and the Chinese streak figures', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    getStatsMock.mockResolvedValueOnce({
      ...activityResponse,
      longestSession: {
        id: 'session-1',
        startedAt: '2026-05-09T08:00:00.000Z',
        endedAt: '2026-05-09T09:30:00.000Z',
        duration: 90 * 60_000,
        messageCount: 12,
        toolCallCount: 4,
      },
    })
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.getByText('1 小时 30 分钟')).toBeInTheDocument()
    expect(screen.getByText('12 消息')).toBeInTheDocument()
  })

  it('shows the empty usage state with the identity but no charts', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    getStatsMock.mockResolvedValueOnce({
      ...activityResponse,
      totalSessions: 0,
      totalMessages: 0,
      activeDays: 0,
      dailyActivity: [],
      dailyModelTokens: [],
      modelUsage: {},
      toolUsage: {},
      skillUsage: {},
      longestSession: null,
      peakActivityDay: null,
      streaks: { currentStreak: 0, longestStreak: 0, currentStreakStart: null, longestStreakStart: null, longestStreakEnd: null },
    })
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.getByText('暂无本地用量')).toBeInTheDocument()
    expect(screen.getByTestId('token-total-value')).toHaveTextContent('0')
    expect(screen.queryByRole('img', { name: /按模型统计的每日 Token/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Token 活动')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '分享图片' })).toBeDisabled()
  })

  it('says so, instead of drawing an empty stream, when all usage is older than the 90-day window', async () => {
    getStatsMock.mockResolvedValueOnce({
      ...activityResponse,
      dailyActivity: [{ date: '2026-01-10', sessionCount: 3, messageCount: 30, toolCallCount: 9 }],
      dailyModelTokens: [{ date: '2026-01-10', tokensByModel: { 'claude-sonnet': 2_864_000 } }],
    })
    render(<ActivitySettings />)

    await flushActivityLoad()

    // The lifetime figure still counts it, and the page still has its other sections…
    expect(screen.getByTestId('token-total-value')).toHaveTextContent('2.9')
    expect(screen.getByRole('heading', { name: 'Token Activity' })).toBeInTheDocument()
    // …but the window has nothing to chart, and the page says that rather than leaving a blank box.
    expect(screen.getByText('No token usage in the last 90 days')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Daily tokens by model, last 90 days' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('stream-peak')).not.toBeInTheDocument()
  })

  it('reports a failed load instead of an empty page', async () => {
    getStatsMock.mockRejectedValueOnce(new Error('stats unavailable'))
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.getByRole('alert')).toHaveTextContent('stats unavailable')
    expect(screen.queryByTestId('token-total-value')).not.toBeInTheDocument()
  })

  it('opens the share dialog from the header', async () => {
    render(<ActivitySettings />)

    await flushActivityLoad()

    expect(screen.queryByText('Share usage image')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Share image' }))
    expect(screen.getByText('Share usage image')).toBeInTheDocument()
  })
})
