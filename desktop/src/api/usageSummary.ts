import { api } from './client'

export type OfficialUsageProviderId =
  | 'claude-official'
  | 'openai-official'
  | 'grok-official'
  | 'deepseek-account'

export type OfficialUsageWindowKind =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_sonnet'
  | 'seven_day_opus'
  | 'seven_day_oauth_apps'
  | 'spark_five_hour'
  | 'spark_seven_day'
  | 'extra_usage'

export type OfficialUsageWindow = {
  id: string
  metricKey: string
  kind: OfficialUsageWindowKind
  usedPercent: number | null
  remainingPercent: number | null
  resetsAt: string | null
  periodMs: number | null
  unlimited?: boolean
}

export type OfficialProviderUsageStatus =
  | 'ok'
  | 'local_only'
  | 'missing_scope'
  | 'rate_limited'
  | 'unavailable'
  | 'not_logged_in'

export type OfficialProviderUsageSummary = {
  providerId: OfficialUsageProviderId
  signedIn: boolean
  status: OfficialProviderUsageStatus
  planLabel: string | null
  accountLabel: string | null
  fetchedAt: string | null
  rateLimitedUntil: string | null
  httpStatus?: number
  windows: OfficialUsageWindow[]
  source: 'official_api' | 'local_only'
}

export type RollingModelTokenUsage = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  turnCount: number
}

export type RollingLocalTokenSummary = {
  windowHours: number
  since: string
  until: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  turnCount: number
  sessionCount: number
  byModel: RollingModelTokenUsage[]
}

export type UnifiedUsageSummaryResponse = {
  fetchedAt: string
  nextAutoRefreshAt: string
  cacheTtlMs: number
  hasSignedInOfficial: boolean
  providers: OfficialProviderUsageSummary[]
  localWindow: RollingLocalTokenSummary
}

export const usageSummaryApi = {
  getSummary(options?: { force?: boolean }): Promise<UnifiedUsageSummaryResponse> {
    const suffix = options?.force ? '?force=1' : ''
    return api.get<UnifiedUsageSummaryResponse>(`/api/usage-summary${suffix}`)
  },
}
