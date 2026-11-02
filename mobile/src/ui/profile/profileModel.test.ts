import { expect, test } from 'bun:test'
import { profileModel, subtitleLink, tokenAmount } from './profileModel'
import type { ProfileStats } from '../../core/profile'

const stats: ProfileStats = {
  totalSessions: 3, activeDays: 2,
  streaks: { currentStreak: 2, longestStreak: 2 },
  longestSession: { duration: 90 * 60000, messageCount: 8 },
  dailyModelTokens: [
    { date: '2026-10-27', tokensByModel: { opus: 100, sonnet: 200 } },
    { date: '2026-10-28', tokensByModel: { opus: 500 } },
    { date: '2026-01-01', tokensByModel: { opus: 2000 } },
  ],
  modelUsage: {
    opus: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 2400, cacheCreationInputTokens: 50 },
    sonnet: { inputTokens: 100, outputTokens: 100 },
  },
}

test('phone totals include cache and old days while the recent chart zero fills only its window', () => {
  const model = profileModel(stats, new Date(2026, 9, 28))
  expect(model.total).toBe(2800)
  expect(model.modelTotal).toBe(2800)
  expect(model.cacheRate).toBe('86%')
  expect(model.models.map((item) => item.id)).toEqual(['opus', 'sonnet'])
  expect(model.recentTotal).toBe(800)
  expect(model.recent).toHaveLength(30)
  expect(model.recent[0]).toEqual({ date: '2026-09-29', tokens: 0 })
  expect(model.recent.at(-1)).toEqual({ date: '2026-10-28', tokens: 500 })
  expect(model.peak).toBe(500)
  expect(model.longestTask).toBe('1 小时 30 分')
})

test('empty data has no invented cache rate, duration or model usage', () => {
  const model = profileModel({ ...stats, longestSession: null, dailyModelTokens: [], modelUsage: {} }, new Date(2026, 2, 9))
  expect(model.cacheRate).toBe('—')
  expect(model.longestTask).toBe('—')
  expect(model.total).toBe(0)
  expect(model.models).toEqual([])
  expect(model.days).toHaveLength(182)
  expect(new Set(model.days.map((day) => day.date)).size).toBe(182)
})

test('compact activity calendar aligns Monday columns and excludes future dates', () => {
  const model = profileModel(stats, new Date(2026, 9, 28))
  expect(new Date(`${model.days[0].date}T12:00:00`).getDay()).toBe(1)
  expect(model.days.filter(day => day.future).map(day => day.date)).toEqual([
    '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01',
  ])
  expect(model.recent.at(-1)?.date).toBe('2026-10-28')
})

test('Chinese token units match the desktop at rounding boundaries', () => {
  expect(tokenAmount(30e9)).toBe('300亿')
  expect(tokenAmount(12345)).toBe('1.2万')
  expect(tokenAmount(11500)).toBe('1.2万')
  expect(tokenAmount(99995000)).toBe('1亿')
  expect(tokenAmount(0)).toBe('0')
})

test('zero-duration single-message tasks do not invent a minute of work', () => {
  const model = profileModel({ ...stats, longestSession: { duration: 0, messageCount: 1 } })
  expect(model.longestTask).toBe('—')
})

test('profile subtitles only open ordinary web links', () => {
  expect(subtitleLink('github.com/NanmiCoder/cc-haha')).toBe('https://github.com/NanmiCoder/cc-haha')
  expect(subtitleLink('https://example.com')).toBe('https://example.com/')
  for (const value of ['javascript:alert(1)', 'file:///tmp/private', 'https://user:password@example.com', '我的日常记录'])
    expect(subtitleLink(value)).toBeNull()
})
