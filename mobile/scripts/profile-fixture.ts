import type { ProfileStats } from '../src/core/profile'

/** Memory-only personal page data for browser/phone smoke, never user transcripts. */
export function profileFixture(hostName: string, today = new Date()) {
  const modelUsage: ProfileStats['modelUsage'] = {}
  const dailyModelTokens = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(today)
    date.setDate(date.getDate() - 89 + index)
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const tokensByModel: Record<string, number> = index % 6 === 0 ? {} : {
      'claude-opus-5-5': (index % 7 + 1) * 38_000_000,
      'claude-sonnet-5-5': (index % 5 + 1) * 14_000_000,
    }
    for (const [id, total] of Object.entries(tokensByModel)) {
      const model = modelUsage[id] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
      model.inputTokens! += total * 0.03
      model.outputTokens! += total * 0.01
      model.cacheReadInputTokens! += total * 0.95
      model.cacheCreationInputTokens! += total * 0.01
    }
    return { date: dateKey, tokensByModel }
  })
  const activeDays = dailyModelTokens.filter((day) => Object.keys(day.tokensByModel).length > 0).length
  return {
    profile: { displayName: '程序员 · Fixture', subtitle: `${hostName} 的使用记录`, avatarDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAiklEQVR4nL3VwQmAMAyF4azm1Rm8OIMDuJIDuIcXj95cwkKgaG3SlxCF/1b4DiFt6Ty2kEg529f5nQ2qEjpXQk1C4qipLFPP6RYpSibuSVY0BCqKFQrpM0aglAjhM/oRQvbIAIE9oG4crH0DZcsNlQsZALHlgyqXNgZKOSDxhfQp4pttItq/CEhwF6Z8OzgcLLeZAAAAAElFTkSuQmCC' },
    stats: {
      totalSessions: 246, totalMessages: 4200, totalDays: 90, activeDays,
      streaks: { currentStreak: 5, longestStreak: 5, currentStreakStart: null, longestStreakStart: null, longestStreakEnd: null },
      longestSession: { sessionId: 'fixture-chat', duration: 11.5 * 3600000, messageCount: 2731, timestamp: today.toISOString() },
      dailyModelTokens, modelUsage,
      dailyActivity: dailyModelTokens.map((day) => ({ date: day.date, sessionCount: Object.keys(day.tokensByModel).length ? 3 : 0, messageCount: 50, toolCallCount: 20 })),
      unpricedModels: [], toolUsage: {}, skillUsage: {},
      firstSessionDate: dailyModelTokens[0].date, lastSessionDate: dailyModelTokens.at(-1)!.date,
      peakActivityDay: null, peakActivityHour: null, totalSpeculationTimeSavedMs: 0,
    },
    range: 'all', generatedAt: today.toISOString(),
  }
}
