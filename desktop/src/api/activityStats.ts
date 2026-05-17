import { api } from './client'

export type ActivityStatsRange = '7d' | '30d' | 'all'

export type DailyActivity = {
  date: string
  messageCount: number
  sessionCount: number
  toolCallCount: number
}

export type DailyModelTokens = {
  date: string
  tokensByModel: Record<string, number>
}

export type StreakInfo = {
  currentStreak: number
  longestStreak: number
  currentStreakStart: string | null
  longestStreakStart: string | null
  longestStreakEnd: string | null
}

export type SessionStats = {
  sessionId: string
  duration: number
  messageCount: number
  timestamp: string
}

export type ActivityStats = {
  totalSessions: number
  totalMessages: number
  totalDays: number
  activeDays: number
  streaks: StreakInfo
  dailyActivity: DailyActivity[]
  dailyModelTokens: DailyModelTokens[]
  longestSession: SessionStats | null
  modelUsage: Record<string, unknown>
  firstSessionDate: string | null
  lastSessionDate: string | null
  peakActivityDay: string | null
  peakActivityHour: number | null
  totalSpeculationTimeSavedMs: number
}

export type ActivityStatsApiResponse = {
  stats: ActivityStats
  range: ActivityStatsRange
  generatedAt: string
}

export type ActivityStatsResponse = ActivityStats & {
  range: ActivityStatsRange
  generatedAt: string
}

export const activityStatsApi = {
  async getStats(range: ActivityStatsRange = 'all'): Promise<ActivityStatsResponse> {
    const suffix = range === 'all' ? '' : `/${range}`
    const response = await api.get<ActivityStatsApiResponse>(`/api/activity-stats${suffix}`, { timeout: 120_000 })
    return {
      ...response.stats,
      range: response.range,
      generatedAt: response.generatedAt,
    }
  },
}
