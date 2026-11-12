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
      ? 'This computer does not support profile sync yet; please update the desktop app.'
      : 'This computer does not support viewing usage yet; please update the desktop app.'
  if (error instanceof ApiError && error.status === 401) return 'Connection is no longer valid; please reconnect this computer.'
  return part === 'profile' ? 'Failed to load profile; check the connection and retry.' : 'Failed to load usage; check that the computer is online and retry.'
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
