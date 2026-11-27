/**
 * OfficialUsageService — unified, rate-limit-safe subscription quota aggregator.
 *
 * Design principles (anti-ban guardrails):
 * 1. Never queries any provider unless the user is already signed in inside cc-haha.
 * 2. Caches each provider's quota for at least 5 minutes so main window, popover,
 *    tray, and floating widget share one cached snapshot without duplicating requests.
 * 3. Deduplicates concurrent in-flight fetches per provider.
 * 4. Enforces a 15-second cooldown on manual force refreshes and strictly honors
 *    HTTP 429 `Retry-After` / exponential backoff (5m -> 10m -> 20m -> 60m).
 * 5. Sends the exact official CLI protocol headers already used by cc-haha's
 *    OAuth clients and disables cross-host redirects on credentialed requests.
 */

import { createHash } from 'node:crypto'
import type { Utilization } from '../../services/api/usage.js'
import { buildGrokIdentityHeaders } from '../../services/grokAuth/fetch.js'
import {
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_TOKEN_USER_AGENT,
} from '../../services/openaiAuth/client.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { getNetworkProxyUrl, loadNetworkSettings } from './networkSettings.js'
import { hahaOAuthService, type ClaudePlanUsageResult } from './hahaOAuthService.js'
import { hahaOpenAIOAuthService, type StoredOpenAIOAuthTokens } from './hahaOpenAIOAuthService.js'
import { hahaGrokOAuthService, type StoredGrokOAuthTokens } from './hahaGrokOAuthService.js'
import { hahaDeepSeekOAuthService, type DeepSeekOAuthStatus } from './hahaDeepSeekOAuthService.js'
import {
  aggregateRollingLocalTokens,
  type RollingLocalTokenSummary,
} from './rollingTokenUsage.js'

export type OfficialUsageProviderId =
  | 'claude-official'
  | 'openai-official'
  | 'grok-official'
  | 'deepseek-account'

export type OfficialUsageWindow = {
  id: string
  /** Stable key across provider + window for pinning, e.g. `claude-official:five_hour`. */
  metricKey: string
  kind: 'five_hour' | 'seven_day' | 'seven_day_sonnet' | 'seven_day_opus' | 'seven_day_oauth_apps' | 'spark_five_hour' | 'spark_seven_day' | 'extra_usage'
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

export type UnifiedUsageSummaryResponse = {
  fetchedAt: string
  nextAutoRefreshAt: string
  cacheTtlMs: number
  hasSignedInOfficial: boolean
  providers: OfficialProviderUsageSummary[]
  localWindow: RollingLocalTokenSummary
}

const CACHE_TTL_MS = 5 * 60 * 1000
const LOCAL_TOKENS_CACHE_TTL_MS = 30 * 1000
const MANUAL_REFRESH_COOLDOWN_MS = 15 * 1000
const GROK_SETTINGS_TTL_MS = 60 * 60 * 1000
const MIN_BACKOFF_MS = 5 * 60 * 1000
const MAX_BACKOFF_MS = 60 * 60 * 1000
const UPSTREAM_TIMEOUT_MS = 10_000
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

const OPENAI_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const GROK_SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings'

type ProviderCacheEntry = {
  summary: OfficialProviderUsageSummary
  fetchedAtMs: number
  backoffUntilMs: number
  consecutiveFailures: number
  tokenIdentity: string
}

type GrokPlanCacheEntry = {
  planLabel: string | null
  fetchedAtMs: number
  tokenIdentity: string
}

type LocalTokensCacheEntry = {
  summary: RollingLocalTokenSummary
  fetchedAtMs: number
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type OfficialUsageServiceDeps = {
  now?: () => number
  fetchImpl?: typeof fetch
  getProxyUrl?: () => Promise<string | null>
  getClaudeTokens?: () => Promise<{ accessToken: string; subscriptionType: string | null } | null>
  getClaudePlanUsage?: () => Promise<ClaudePlanUsageResult>
  getOpenAITokens?: () => Promise<StoredOpenAIOAuthTokens | null>
  getGrokTokens?: () => Promise<StoredGrokOAuthTokens | null>
  getDeepSeekStatus?: () => Promise<DeepSeekOAuthStatus>
  aggregateLocalTokens?: (now: Date) => Promise<RollingLocalTokenSummary>
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function parseRetryAfterMs(headerValue: string | null, nowMs: number): number | null {
  if (!headerValue) return null
  const trimmed = headerValue.trim()
  if (!trimmed) return null
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, Math.round(seconds * 1000)))
  }
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs) && dateMs > nowMs) {
    return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, dateMs - nowMs))
  }
  return null
}

function computeExponentialBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(4, consecutiveFailures - 1))
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * (2 ** exponent))
}

function formatClaudePlan(subscriptionType: string | null | undefined): string | null {
  if (!subscriptionType) return null
  switch (subscriptionType.toLowerCase()) {
    case 'max':
      return 'Max'
    case 'pro':
      return 'Pro'
    case 'team':
      return 'Team'
    case 'enterprise':
      return 'Enterprise'
    case 'ultra':
      return 'Ultra'
    default:
      return subscriptionType
  }
}

function formatOpenAIPlan(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null
  const known: Record<string, string> = {
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    enterprise: 'Enterprise',
    edu: 'Edu',
    free: 'Free',
    go: 'Go',
  }
  return known[trimmed] ?? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function mapClaudeWindows(usage: Utilization): OfficialUsageWindow[] {
  const specs: ReadonlyArray<{
    key: 'five_hour' | 'seven_day' | 'seven_day_sonnet' | 'seven_day_opus' | 'seven_day_oauth_apps'
    periodMs: number
  }> = [
    { key: 'five_hour', periodMs: FIVE_HOURS_MS },
    { key: 'seven_day', periodMs: SEVEN_DAYS_MS },
    { key: 'seven_day_sonnet', periodMs: SEVEN_DAYS_MS },
    { key: 'seven_day_opus', periodMs: SEVEN_DAYS_MS },
    { key: 'seven_day_oauth_apps', periodMs: SEVEN_DAYS_MS },
  ]

  const windows: OfficialUsageWindow[] = []
  for (const spec of specs) {
    const entry = usage[spec.key]
    if (!entry) continue
    const rawUsed = parseFiniteNumber(entry.utilization)
    const usedPercent = rawUsed === null ? null : clampPercent(rawUsed)
    windows.push({
      id: spec.key,
      metricKey: `claude-official:${spec.key}`,
      kind: spec.key,
      usedPercent,
      remainingPercent: usedPercent === null ? null : 100 - usedPercent,
      resetsAt: typeof entry.resets_at === 'string' && entry.resets_at.trim() ? entry.resets_at : null,
      periodMs: spec.periodMs,
    })
  }

  if (usage.extra_usage?.is_enabled) {
    const unlimited = usage.extra_usage.monthly_limit === null
    const rawUsed = unlimited ? null : parseFiniteNumber(usage.extra_usage.utilization)
    const usedPercent = rawUsed === null ? null : clampPercent(rawUsed)
    windows.push({
      id: 'extra_usage',
      metricKey: 'claude-official:extra_usage',
      kind: 'extra_usage',
      usedPercent,
      remainingPercent: usedPercent === null ? null : 100 - usedPercent,
      resetsAt: null,
      periodMs: null,
      unlimited,
    })
  }

  return windows
}

function parseOpenAIResetIso(windowObj: Record<string, unknown>, nowMs: number): string | null {
  const resetAt = parseFiniteNumber(windowObj.reset_at)
  if (resetAt !== null && resetAt > 0) {
    // OpenAI returns epoch seconds.
    const ms = resetAt > 1e12 ? resetAt : resetAt * 1000
    return new Date(ms).toISOString()
  }
  const resetAfter = parseFiniteNumber(windowObj.reset_after_seconds)
  if (resetAfter !== null && resetAfter >= 0) {
    return new Date(nowMs + resetAfter * 1000).toISOString()
  }
  return null
}

function parseOpenAIWindowList(
  rateLimit: Record<string, unknown> | null,
  prefix: 'primary' | 'spark',
  headerPercents: { primary: number | null; secondary: number | null },
  nowMs: number,
): OfficialUsageWindow[] {
  const rawPrimary = rateLimit?.primary_window && typeof rateLimit.primary_window === 'object'
    ? rateLimit.primary_window as Record<string, unknown>
    : null
  const rawSecondary = rateLimit?.secondary_window && typeof rateLimit.secondary_window === 'object'
    ? rateLimit.secondary_window as Record<string, unknown>
    : null

  const slots = [
    rawPrimary || headerPercents.primary !== null
      ? {
          window: rawPrimary ?? {},
          used: parseFiniteNumber(rawPrimary?.used_percent) ?? headerPercents.primary,
          periodMs: (() => {
            const seconds = parseFiniteNumber(rawPrimary?.limit_window_seconds)
            return seconds !== null && seconds > 0 ? Math.round(seconds * 1000) : null
          })(),
        }
      : null,
    rawSecondary || headerPercents.secondary !== null
      ? {
          window: rawSecondary ?? {},
          used: parseFiniteNumber(rawSecondary?.used_percent) ?? headerPercents.secondary,
          periodMs: (() => {
            const seconds = parseFiniteNumber(rawSecondary?.limit_window_seconds)
            return seconds !== null && seconds > 0 ? Math.round(seconds * 1000) : null
          })(),
        }
      : null,
  ]

  const meters = prefix === 'primary'
    ? [
        { id: 'five_hour', kind: 'five_hour' as const, periodMs: FIVE_HOURS_MS },
        { id: 'seven_day', kind: 'seven_day' as const, periodMs: SEVEN_DAYS_MS },
      ]
    : [
        { id: 'spark_five_hour', kind: 'spark_five_hour' as const, periodMs: FIVE_HOURS_MS },
        { id: 'spark_seven_day', kind: 'spark_seven_day' as const, periodMs: SEVEN_DAYS_MS },
      ]

  const knownPeriods = new Set(meters.map((m) => m.periodMs))
  const windows: OfficialUsageWindow[] = []

  meters.forEach((meter, index) => {
    const exact = slots.find((slot) => slot !== null && slot.periodMs === meter.periodMs) ?? null
    const fallbackCandidate = slots[index]
    const fallback = fallbackCandidate && (fallbackCandidate.periodMs === null || !knownPeriods.has(fallbackCandidate.periodMs))
      ? fallbackCandidate
      : null
    const chosen = exact ?? fallback
    if (!chosen || chosen.used === null) return
    const usedPercent = clampPercent(chosen.used)
    windows.push({
      id: meter.id,
      metricKey: `openai-official:${meter.id}`,
      kind: meter.kind,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: parseOpenAIResetIso(chosen.window, nowMs),
      periodMs: chosen.periodMs ?? meter.periodMs,
    })
  })

  return windows
}

function mapOpenAIWhamResponse(
  body: Record<string, unknown>,
  headers: Headers,
  nowMs: number,
): { planLabel: string | null; windows: OfficialUsageWindow[] } {
  const rateLimit = body.rate_limit && typeof body.rate_limit === 'object'
    ? body.rate_limit as Record<string, unknown>
    : null
  const windows = parseOpenAIWindowList(
    rateLimit,
    'primary',
    {
      primary: parseFiniteNumber(headers.get('x-codex-primary-used-percent')),
      secondary: parseFiniteNumber(headers.get('x-codex-secondary-used-percent')),
    },
    nowMs,
  )

  const additional = Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []
  const sparkEntry = additional.find((item) => {
    if (!item || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    const names = [record.limit_name, record.metered_feature]
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.toLowerCase())
    return names.some((v) => v.includes('spark'))
  }) as Record<string, unknown> | undefined
  if (sparkEntry?.rate_limit && typeof sparkEntry.rate_limit === 'object') {
    windows.push(
      ...parseOpenAIWindowList(
        sparkEntry.rate_limit as Record<string, unknown>,
        'spark',
        { primary: null, secondary: null },
        nowMs,
      ),
    )
  }

  return {
    planLabel: formatOpenAIPlan(body.plan_type),
    windows,
  }
}

function parseGrokBillingPayload(payload: unknown): OfficialUsageWindow[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const record = payload as Record<string, unknown>

  // Support both snake_case and camelCase JSON shapes reported by cli-chat-proxy.grok.com/v1/billing.
  const nested = (record.credits_config && typeof record.credits_config === 'object'
    ? record.credits_config
    : record.creditsConfig && typeof record.creditsConfig === 'object'
      ? record.creditsConfig
      : record) as Record<string, unknown>

  const directUsed = parseFiniteNumber(nested.used_percent ?? nested.usedPercent)
  const limit = parseFiniteNumber(nested.limit ?? nested.weekly_limit ?? nested.weeklyLimit ?? nested.total)
  const used = parseFiniteNumber(nested.used ?? nested.consumed ?? nested.spent)
  const remaining = parseFiniteNumber(nested.remaining ?? nested.available)

  let usedPercent: number | null = null
  if (directUsed !== null) {
    usedPercent = clampPercent(directUsed <= 1 && directUsed > 0 ? directUsed * 100 : directUsed)
  } else if (limit !== null && limit > 0) {
    if (used !== null) {
      usedPercent = clampPercent((used / limit) * 100)
    } else if (remaining !== null) {
      usedPercent = clampPercent(((limit - remaining) / limit) * 100)
    }
  }

  if (usedPercent === null) return []

  const rawPeriodEnd = nested.period_end ?? nested.periodEnd ?? nested.resets_at ?? nested.resetsAt
  let resetsAt: string | null = null
  if (typeof rawPeriodEnd === 'string' && rawPeriodEnd.trim() && !Number.isNaN(Date.parse(rawPeriodEnd))) {
    resetsAt = new Date(rawPeriodEnd).toISOString()
  } else {
    const epoch = parseFiniteNumber(rawPeriodEnd)
    if (epoch !== null && epoch > 0) {
      resetsAt = new Date(epoch > 1e12 ? epoch : epoch * 1000).toISOString()
    }
  }

  return [
    {
      id: 'seven_day',
      metricKey: 'grok-official:seven_day',
      kind: 'seven_day',
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt,
      periodMs: SEVEN_DAYS_MS,
    },
  ]
}

export class OfficialUsageService {
  private readonly cache = new Map<OfficialUsageProviderId, ProviderCacheEntry>()
  private readonly inFlight = new Map<OfficialUsageProviderId, Promise<OfficialProviderUsageSummary>>()
  private grokPlanCache: GrokPlanCacheEntry | null = null
  private localTokensCache: LocalTokensCacheEntry | null = null
  private localTokensInFlight: Promise<RollingLocalTokenSummary> | null = null

  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly getProxyUrl: () => Promise<string | null>
  private readonly getClaudeTokens: () => Promise<{ accessToken: string; subscriptionType: string | null } | null>
  private readonly getClaudePlanUsage: () => Promise<ClaudePlanUsageResult>
  private readonly getOpenAITokens: () => Promise<StoredOpenAIOAuthTokens | null>
  private readonly getGrokTokens: () => Promise<StoredGrokOAuthTokens | null>
  private readonly getDeepSeekStatus: () => Promise<DeepSeekOAuthStatus>
  private readonly aggregateLocalTokens: (now: Date) => Promise<RollingLocalTokenSummary>

  constructor(deps: OfficialUsageServiceDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch
    this.getProxyUrl = deps.getProxyUrl ?? (async () => getNetworkProxyUrl(await loadNetworkSettings()))
    this.getClaudeTokens = deps.getClaudeTokens ?? (() => hahaOAuthService.ensureFreshTokens().catch(() => null))
    this.getClaudePlanUsage = deps.getClaudePlanUsage ?? (() => hahaOAuthService.getPlanUsage())
    this.getOpenAITokens = deps.getOpenAITokens ?? (() => hahaOpenAIOAuthService.ensureFreshTokens().catch(() => null))
    this.getGrokTokens = deps.getGrokTokens ?? (() => hahaGrokOAuthService.ensureFreshTokens().catch(() => null))
    this.getDeepSeekStatus = deps.getDeepSeekStatus ?? (() => hahaDeepSeekOAuthService.getStatus().catch(() => ({ loggedIn: false as const })))
    this.aggregateLocalTokens = deps.aggregateLocalTokens ?? ((now) => aggregateRollingLocalTokens({ windowHours: 5, now }))
  }

  clearCache(): void {
    this.cache.clear()
    this.inFlight.clear()
    this.grokPlanCache = null
    this.localTokensCache = null
    this.localTokensInFlight = null
  }

  async getSummary(options: { force?: boolean } = {}): Promise<UnifiedUsageSummaryResponse> {
    const force = options.force === true
    const nowMs = this.now()
    const nowDate = new Date(nowMs)

    const [claude, openai, grok, deepseek, localWindow] = await Promise.all([
      this.readClaude(force),
      this.readOpenAI(force),
      this.readGrok(force),
      this.readDeepSeek(),
      this.readLocalTokens(nowDate, nowMs, force),
    ])

    const providers = [claude, openai, grok, deepseek]
    const hasSignedInOfficial = providers.some((provider) => provider.signedIn)

    return {
      fetchedAt: nowDate.toISOString(),
      nextAutoRefreshAt: new Date(nowMs + CACHE_TTL_MS).toISOString(),
      cacheTtlMs: CACHE_TTL_MS,
      hasSignedInOfficial,
      providers,
      localWindow,
    }
  }

  private async readLocalTokens(
    nowDate: Date,
    nowMs: number,
    force: boolean,
  ): Promise<RollingLocalTokenSummary> {
    if (
      !force &&
      this.localTokensCache &&
      nowMs - this.localTokensCache.fetchedAtMs < LOCAL_TOKENS_CACHE_TTL_MS
    ) {
      return this.localTokensCache.summary
    }
    if (this.localTokensInFlight) return this.localTokensInFlight

    const operation = this.aggregateLocalTokens(nowDate)
      .then((summary) => {
        this.localTokensCache = { summary, fetchedAtMs: this.now() }
        return summary
      })
      .catch((): RollingLocalTokenSummary => ({
        windowHours: 5,
        since: new Date(nowMs - FIVE_HOURS_MS).toISOString(),
        until: nowDate.toISOString(),
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turnCount: 0,
        sessionCount: 0,
        byModel: [],
      }))
      .finally(() => {
        if (this.localTokensInFlight === operation) {
          this.localTokensInFlight = null
        }
      })

    this.localTokensInFlight = operation
    return operation
  }

  private async runWithCache(
    providerId: OfficialUsageProviderId,
    tokenIdentity: string,
    force: boolean,
    fetcher: () => Promise<{
      summary: OfficialProviderUsageSummary
      rateLimitedRetryAfterMs?: number | null
      failed?: boolean
    }>,
  ): Promise<OfficialProviderUsageSummary> {
    const nowMs = this.now()
    const cached = this.cache.get(providerId)

    if (cached && cached.tokenIdentity === tokenIdentity) {
      // Never bypass an active HTTP 429 rate-limit window, even on manual refresh.
      if (cached.backoffUntilMs > nowMs && cached.summary.status === 'rate_limited') {
        return cached.summary
      }
      const ageMs = nowMs - cached.fetchedAtMs
      if (!force && ageMs < CACHE_TTL_MS) {
        return cached.summary
      }
      if (!force && cached.backoffUntilMs > nowMs) {
        return cached.summary
      }
      if (force && ageMs < MANUAL_REFRESH_COOLDOWN_MS) {
        return cached.summary
      }
    }

    const existingPromise = this.inFlight.get(providerId)
    if (existingPromise) return existingPromise

    const operation = (async () => {
      const outcome = await fetcher()
      const finishedAtMs = this.now()
      const previousFailures = cached && cached.tokenIdentity === tokenIdentity
        ? cached.consecutiveFailures
        : 0

      if (outcome.summary.status === 'rate_limited') {
        const nextFailures = previousFailures + 1
        const waitMs = outcome.rateLimitedRetryAfterMs ?? computeExponentialBackoffMs(nextFailures)
        const backoffUntilMs = finishedAtMs + waitMs
        const summary: OfficialProviderUsageSummary = {
          ...outcome.summary,
          // Keep last known good windows if we had them for the same account.
          windows: outcome.summary.windows.length > 0
            ? outcome.summary.windows
            : (cached && cached.tokenIdentity === tokenIdentity ? cached.summary.windows : []),
          rateLimitedUntil: new Date(backoffUntilMs).toISOString(),
        }
        this.cache.set(providerId, {
          summary,
          fetchedAtMs: finishedAtMs,
          backoffUntilMs,
          consecutiveFailures: nextFailures,
          tokenIdentity,
        })
        return summary
      }

      if (outcome.failed) {
        const nextFailures = previousFailures + 1
        const backoffUntilMs = finishedAtMs + computeExponentialBackoffMs(nextFailures)
        const summary: OfficialProviderUsageSummary = {
          ...outcome.summary,
          windows: cached && cached.tokenIdentity === tokenIdentity && cached.summary.windows.length > 0
            ? cached.summary.windows
            : outcome.summary.windows,
        }
        this.cache.set(providerId, {
          summary,
          fetchedAtMs: finishedAtMs,
          backoffUntilMs,
          consecutiveFailures: nextFailures,
          tokenIdentity,
        })
        return summary
      }

      this.cache.set(providerId, {
        summary: outcome.summary,
        fetchedAtMs: finishedAtMs,
        backoffUntilMs: 0,
        consecutiveFailures: 0,
        tokenIdentity,
      })
      return outcome.summary
    })().finally(() => {
      if (this.inFlight.get(providerId) === operation) {
        this.inFlight.delete(providerId)
      }
    })

    this.inFlight.set(providerId, operation)
    return operation
  }

  private async readClaude(force: boolean): Promise<OfficialProviderUsageSummary> {
    const tokens = await this.getClaudeTokens()
    if (!tokens) {
      this.cache.delete('claude-official')
      return {
        providerId: 'claude-official',
        signedIn: false,
        status: 'not_logged_in',
        planLabel: null,
        accountLabel: null,
        fetchedAt: null,
        rateLimitedUntil: null,
        windows: [],
        source: 'official_api',
      }
    }

    const tokenIdentity = `claude:${hashToken(tokens.accessToken)}:${tokens.subscriptionType ?? ''}`
    return this.runWithCache('claude-official', tokenIdentity, force, async () => {
      const result = await this.getClaudePlanUsage()
      const planLabel = formatClaudePlan(tokens.subscriptionType)

      if (result.available) {
        return {
          summary: {
            providerId: 'claude-official',
            signedIn: true,
            status: 'ok',
            planLabel,
            accountLabel: null,
            fetchedAt: result.fetchedAt,
            rateLimitedUntil: null,
            windows: mapClaudeWindows(result.usage),
            source: 'official_api',
          },
        }
      }

      if (result.reason === 'missing_scope') {
        return {
          summary: {
            providerId: 'claude-official',
            signedIn: true,
            status: 'missing_scope',
            planLabel,
            accountLabel: null,
            fetchedAt: result.fetchedAt,
            rateLimitedUntil: null,
            windows: [],
            source: 'official_api',
          },
        }
      }

      if (result.status === 429) {
        return {
          summary: {
            providerId: 'claude-official',
            signedIn: true,
            status: 'rate_limited',
            planLabel,
            accountLabel: null,
            fetchedAt: result.fetchedAt,
            rateLimitedUntil: null,
            httpStatus: 429,
            windows: [],
            source: 'official_api',
          },
          failed: true,
        }
      }

      return {
        summary: {
          providerId: 'claude-official',
          signedIn: true,
          status: 'unavailable',
          planLabel,
          accountLabel: null,
          fetchedAt: result.fetchedAt,
          rateLimitedUntil: null,
          ...(result.status ? { httpStatus: result.status } : {}),
          windows: [],
          source: 'official_api',
        },
        failed: true,
      }
    })
  }

  private async readOpenAI(force: boolean): Promise<OfficialProviderUsageSummary> {
    const tokens = await this.getOpenAITokens()
    if (!tokens) {
      this.cache.delete('openai-official')
      return {
        providerId: 'openai-official',
        signedIn: false,
        status: 'not_logged_in',
        planLabel: null,
        accountLabel: null,
        fetchedAt: null,
        rateLimitedUntil: null,
        windows: [],
        source: 'official_api',
      }
    }

    const tokenIdentity = `openai:${tokens.accountId ?? ''}:${tokens.email ?? ''}:${hashToken(tokens.accessToken)}`
    return this.runWithCache('openai-official', tokenIdentity, force, async () => {
      const nowMs = this.now()
      const fetchedAt = new Date(nowMs).toISOString()
      const proxyUrl = await this.getProxyUrl()
      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: 'application/json',
        originator: OPENAI_CODEX_ORIGINATOR,
        'User-Agent': OPENAI_CODEX_TOKEN_USER_AGENT,
      }
      if (tokens.accountId) {
        headers['ChatGPT-Account-Id'] = tokens.accountId
      }

      try {
        const response = await this.fetchImpl(OPENAI_WHAM_USAGE_URL, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          ...getProxyFetchOptions({ proxyUrl, targetUrl: OPENAI_WHAM_USAGE_URL }),
        })

        if (response.status === 429) {
          return {
            summary: {
              providerId: 'openai-official',
              signedIn: true,
              status: 'rate_limited',
              planLabel: null,
              accountLabel: tokens.email,
              fetchedAt,
              rateLimitedUntil: null,
              httpStatus: 429,
              windows: [],
              source: 'official_api',
            },
            rateLimitedRetryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), nowMs),
            failed: true,
          }
        }

        if (!response.ok) {
          return {
            summary: {
              providerId: 'openai-official',
              signedIn: true,
              status: 'unavailable',
              planLabel: null,
              accountLabel: tokens.email,
              fetchedAt,
              rateLimitedUntil: null,
              httpStatus: response.status,
              windows: [],
              source: 'official_api',
            },
            failed: true,
          }
        }

        const body = await response.json() as Record<string, unknown>
        const mapped = mapOpenAIWhamResponse(body, response.headers, nowMs)
        return {
          summary: {
            providerId: 'openai-official',
            signedIn: true,
            status: 'ok',
            planLabel: mapped.planLabel,
            accountLabel: tokens.email,
            fetchedAt,
            rateLimitedUntil: null,
            windows: mapped.windows,
            source: 'official_api',
          },
        }
      } catch {
        return {
          summary: {
            providerId: 'openai-official',
            signedIn: true,
            status: 'unavailable',
            planLabel: null,
            accountLabel: tokens.email,
            fetchedAt,
            rateLimitedUntil: null,
            windows: [],
            source: 'official_api',
          },
          failed: true,
        }
      }
    })
  }

  private async readGrok(force: boolean): Promise<OfficialProviderUsageSummary> {
    const tokens = await this.getGrokTokens()
    if (!tokens) {
      this.cache.delete('grok-official')
      this.grokPlanCache = null
      return {
        providerId: 'grok-official',
        signedIn: false,
        status: 'not_logged_in',
        planLabel: null,
        accountLabel: null,
        fetchedAt: null,
        rateLimitedUntil: null,
        windows: [],
        source: 'official_api',
      }
    }

    const tokenIdentity = `grok:${tokens.email ?? ''}:${hashToken(tokens.accessToken)}`
    return this.runWithCache('grok-official', tokenIdentity, force, async () => {
      const nowMs = this.now()
      const fetchedAt = new Date(nowMs).toISOString()
      const proxyUrl = await this.getProxyUrl()
      const buildHeaders = (): Headers => {
        const headers = buildGrokIdentityHeaders(tokens.accessToken.trim())
        headers.set('Accept', 'application/json')
        headers.delete('Content-Type')
        return headers
      }

      const planLabel = await this.readGrokPlanLabel(buildHeaders(), tokenIdentity, proxyUrl, nowMs)

      try {
        const response = await this.fetchImpl(GROK_BILLING_URL, {
          method: 'GET',
          headers: buildHeaders(),
          redirect: 'error',
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          ...getProxyFetchOptions({ proxyUrl, targetUrl: GROK_BILLING_URL }),
        })

        if (response.status === 429) {
          return {
            summary: {
              providerId: 'grok-official',
              signedIn: true,
              status: 'rate_limited',
              planLabel,
              accountLabel: tokens.email,
              fetchedAt,
              rateLimitedUntil: null,
              httpStatus: 429,
              windows: [],
              source: 'official_api',
            },
            rateLimitedRetryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), nowMs),
            failed: true,
          }
        }

        if (response.status === 412) {
          // Team accounts have no personal quota.
          return {
            summary: {
              providerId: 'grok-official',
              signedIn: true,
              status: 'local_only',
              planLabel,
              accountLabel: tokens.email,
              fetchedAt,
              rateLimitedUntil: null,
              windows: [],
              source: 'local_only',
            },
          }
        }

        if (!response.ok) {
          return {
            summary: {
              providerId: 'grok-official',
              signedIn: true,
              status: 'unavailable',
              planLabel,
              accountLabel: tokens.email,
              fetchedAt,
              rateLimitedUntil: null,
              httpStatus: response.status,
              windows: [],
              source: 'official_api',
            },
            failed: true,
          }
        }

        const payload = await response.json().catch(() => null)
        const windows = parseGrokBillingPayload(payload)
        return {
          summary: {
            providerId: 'grok-official',
            signedIn: true,
            status: windows.length > 0 ? 'ok' : 'unavailable',
            planLabel,
            accountLabel: tokens.email,
            fetchedAt,
            rateLimitedUntil: null,
            windows,
            source: 'official_api',
          },
          failed: windows.length === 0,
        }
      } catch {
        return {
          summary: {
            providerId: 'grok-official',
            signedIn: true,
            status: 'unavailable',
            planLabel,
            accountLabel: tokens.email,
            fetchedAt,
            rateLimitedUntil: null,
            windows: [],
            source: 'official_api',
          },
          failed: true,
        }
      }
    })
  }

  private async readGrokPlanLabel(
    headers: Headers,
    tokenIdentity: string,
    proxyUrl: string | null,
    nowMs: number,
  ): Promise<string | null> {
    if (
      this.grokPlanCache &&
      this.grokPlanCache.tokenIdentity === tokenIdentity &&
      nowMs - this.grokPlanCache.fetchedAtMs < GROK_SETTINGS_TTL_MS
    ) {
      return this.grokPlanCache.planLabel
    }

    try {
      const response = await this.fetchImpl(GROK_SETTINGS_URL, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ...getProxyFetchOptions({ proxyUrl, targetUrl: GROK_SETTINGS_URL }),
      })
      if (!response.ok) return this.grokPlanCache?.planLabel ?? null
      const body = await response.json().catch(() => null) as Record<string, unknown> | null
      const rawPlan = typeof body?.subscription_tier_display === 'string'
        ? body.subscription_tier_display.trim()
        : ''
      const planLabel = rawPlan || null
      this.grokPlanCache = { planLabel, fetchedAtMs: nowMs, tokenIdentity }
      return planLabel
    } catch {
      return this.grokPlanCache?.planLabel ?? null
    }
  }

  private async readDeepSeek(): Promise<OfficialProviderUsageSummary> {
    const status = await this.getDeepSeekStatus()
    if (!status.loggedIn) {
      return {
        providerId: 'deepseek-account',
        signedIn: false,
        status: 'not_logged_in',
        planLabel: null,
        accountLabel: null,
        fetchedAt: null,
        rateLimitedUntil: null,
        windows: [],
        source: 'local_only',
      }
    }
    return {
      providerId: 'deepseek-account',
      signedIn: true,
      status: 'local_only',
      planLabel: null,
      accountLabel: status.name ?? status.contact ?? null,
      fetchedAt: new Date(this.now()).toISOString(),
      rateLimitedUntil: null,
      windows: [],
      source: 'local_only',
    }
  }
}

export const officialUsageService = new OfficialUsageService()
