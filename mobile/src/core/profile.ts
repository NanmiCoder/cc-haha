import { ApiError, type ApiClient } from './client'

export type PersonalProfile = {
  displayName: string
  subtitle: string
  avatarDataUrl: string | null
}

/** The existing desktop activity API, narrowed to the phone's overview. */
export type ProfileStats = {
  totalSessions: number
  activeDays: number
  streaks: { currentStreak: number; longestStreak: number }
  longestSession: { duration: number; messageCount: number } | null
  dailyModelTokens: { date: string; tokensByModel: Record<string, number> }[]
  modelUsage: Record<string, {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }>
}

export type ProfileOverview = {
  profile: PersonalProfile | null
  stats: ProfileStats | null
  profileError: string
  statsError: string
}

export async function loadPersonalProfile(client: ApiClient, signal?: AbortSignal): Promise<PersonalProfile> {
  const { profile } = await client.get<{ profile: PersonalProfile }>('/api/desktop-ui/preferences/profile', { signal })
  return profile
}

function readError(error: unknown, part: 'profile' | 'stats') {
  if (error instanceof ApiError && [403, 404, 405].includes(error.status))
    return part === 'profile'
      ? '这台电脑暂不支持同步个人资料，请更新电脑端。'
      : '这台电脑暂不支持查看用量，请更新电脑端。'
  if (error instanceof ApiError && error.status === 401) return '连接已失效，请重新连接这台电脑。'
  return part === 'profile' ? '个人资料读取失败，请检查连接后重试。' : '用量读取失败，请检查电脑是否在线后重试。'
}

/** A missing profile on an older computer must not hide otherwise available usage. */
export async function loadProfileOverview(client: ApiClient, signal?: AbortSignal): Promise<ProfileOverview> {
  const [profile, stats] = await Promise.allSettled([
    loadPersonalProfile(client, signal),
    client.get<{ stats: ProfileStats }>('/api/activity-stats', { signal, timeoutMs: 120_000 }),
  ])
  return {
    profile: profile.status === 'fulfilled' ? profile.value : null,
    stats: stats.status === 'fulfilled' ? stats.value.stats : null,
    profileError: profile.status === 'rejected' ? readError(profile.reason, 'profile') : '',
    statsError: stats.status === 'rejected' ? readError(stats.reason, 'stats') : '',
  }
}
