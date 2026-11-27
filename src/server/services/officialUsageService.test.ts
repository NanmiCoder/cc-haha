import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { OfficialUsageService } from './officialUsageService.js'
import { aggregateRollingLocalTokens } from './rollingTokenUsage.js'
import { handleApiRequest } from '../router.js'
import { isUsageWidgetHttpRequestAllowed } from '../usageWidgetAccessPolicy.js'
import { GROK_CLI_VERSION } from '../../services/grokAuth/fetch.js'
import { OPENAI_CODEX_ORIGINATOR, OPENAI_CODEX_TOKEN_USER_AGENT } from '../../services/openaiAuth/client.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('OfficialUsageService', () => {
  it('makes zero upstream requests when no official accounts are signed in', async () => {
    const fetchMock = mock(async () => new Response('{}', { status: 200 }))
    const claudeUsageMock = mock(async () => ({
      available: false as const,
      fetchedAt: '2026-11-26T18:00:00.000Z',
      reason: 'not_logged_in' as const,
    }))

    const service = new OfficialUsageService({
      now: () => Date.parse('2026-11-26T18:00:00.000Z'),
      fetchImpl: fetchMock as unknown as typeof fetch,
      getProxyUrl: async () => null,
      getClaudeTokens: async () => null,
      getClaudePlanUsage: claudeUsageMock,
      getOpenAITokens: async () => null,
      getGrokTokens: async () => null,
      getDeepSeekStatus: async () => ({ loggedIn: false }),
      aggregateLocalTokens: async () => ({
        windowHours: 5,
        since: '2026-11-26T13:00:00.000Z',
        until: '2026-11-26T18:00:00.000Z',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turnCount: 0,
        sessionCount: 0,
        byModel: [],
      }),
    })

    const summary = await service.getSummary()
    expect(summary.hasSignedInOfficial).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(claudeUsageMock).not.toHaveBeenCalled()
    expect(summary.providers.every((provider) => !provider.signedIn)).toBe(true)
  })

  it('aggregates Claude, ChatGPT, Grok, and DeepSeek and caches within 5 minutes', async () => {
    let currentTimeMs = Date.parse('2026-11-26T18:00:00.000Z')
    const fetchCalls: Array<{ url: string; headers: Headers; redirect: RequestRedirect | undefined }> = []
    const fetchMock = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      fetchCalls.push({
        url,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
      })
      if (url.includes('/backend-api/wham/usage')) {
        return new Response(JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 18, limit_window_seconds: 18_000, reset_after_seconds: 7200 },
            secondary_window: { used_percent: 33, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/v1/settings')) {
        return new Response(JSON.stringify({ subscription_tier_display: 'SuperGrok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/v1/billing')) {
        return new Response(JSON.stringify({
          used_percent: 25,
          period_end: '2026-12-01T00:00:00.000Z',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    })

    const claudeUsageMock = mock(async () => ({
      available: true as const,
      fetchedAt: new Date(currentTimeMs).toISOString(),
      usage: {
        five_hour: { utilization: 38, resets_at: '2026-11-26T20:00:00.000Z' },
        seven_day: { utilization: 26, resets_at: '2026-11-30T00:00:00.000Z' },
      },
    }))

    const service = new OfficialUsageService({
      now: () => currentTimeMs,
      fetchImpl: fetchMock as unknown as typeof fetch,
      getProxyUrl: async () => null,
      getClaudeTokens: async () => ({ accessToken: 'cl-tok-123456', subscriptionType: 'max' }),
      getClaudePlanUsage: claudeUsageMock,
      getOpenAITokens: async () => ({
        accessToken: 'oa-tok-123456',
        refreshToken: 'oa-ref',
        expiresAt: currentTimeMs + 3_600_000,
        email: 'dev@example.com',
        accountId: 'acct_123',
      }),
      getGrokTokens: async () => ({
        accessToken: 'gk-tok-123456',
        refreshToken: 'gk-ref',
        expiresAt: currentTimeMs + 3_600_000,
        email: 'grok@example.com',
      }),
      getDeepSeekStatus: async () => ({ loggedIn: true, name: 'DeepSeek User', contact: 'ds@example.com' }),
      aggregateLocalTokens: async () => ({
        windowHours: 5,
        since: '2026-11-26T13:00:00.000Z',
        until: '2026-11-26T18:00:00.000Z',
        totalTokens: 120_000,
        inputTokens: 80_000,
        outputTokens: 20_000,
        cacheReadTokens: 20_000,
        cacheCreationTokens: 0,
        turnCount: 4,
        sessionCount: 2,
        byModel: [],
      }),
    })

    const first = await service.getSummary()
    expect(first.hasSignedInOfficial).toBe(true)

    const claude = first.providers.find((p) => p.providerId === 'claude-official')!
    expect(claude.status).toBe('ok')
    expect(claude.planLabel).toBe('Max')
    expect(claude.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 38, remainingPercent: 62 })

    const openai = first.providers.find((p) => p.providerId === 'openai-official')!
    expect(openai.status).toBe('ok')
    expect(openai.planLabel).toBe('Pro')
    expect(openai.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 18, remainingPercent: 82 })
    expect(openai.windows[1]).toMatchObject({ id: 'seven_day', usedPercent: 33, remainingPercent: 67 })

    const grok = first.providers.find((p) => p.providerId === 'grok-official')!
    expect(grok.status).toBe('ok')
    expect(grok.planLabel).toBe('SuperGrok')
    expect(grok.windows[0]).toMatchObject({ id: 'seven_day', usedPercent: 25, remainingPercent: 75 })

    const deepseek = first.providers.find((p) => p.providerId === 'deepseek-account')!
    expect(deepseek.signedIn).toBe(true)
    expect(deepseek.status).toBe('local_only')

    const openaiCall = fetchCalls.find((c) => c.url.includes('/backend-api/wham/usage'))!
    expect(openaiCall.redirect).toBe('error')
    expect(openaiCall.headers.get('originator')).toBe(OPENAI_CODEX_ORIGINATOR)
    expect(openaiCall.headers.get('user-agent')).toBe(OPENAI_CODEX_TOKEN_USER_AGENT)
    expect(openaiCall.headers.get('chatgpt-account-id')).toBe('acct_123')

    const grokSettingsCall = fetchCalls.find((c) => c.url.includes('/v1/settings'))!
    const grokBillingCall = fetchCalls.find((c) => c.url.includes('/v1/billing'))!
    for (const grokCall of [grokSettingsCall, grokBillingCall]) {
      expect(grokCall.redirect).toBe('error')
      expect(grokCall.headers.get('x-grok-client-version')).toBe(GROK_CLI_VERSION)
      expect(grokCall.headers.get('x-grok-client-mode')).toBe('interactive')
      expect(grokCall.headers.get('x-xai-token-auth')).toBe('xai-grok-cli')
      expect(grokCall.headers.get('accept')).toBe('application/json')
      expect(grokCall.headers.get('user-agent')).toContain(`grok-pager/${GROK_CLI_VERSION}`)
    }

    // Second call within 5 minutes serves cached values without upstream hits.
    currentTimeMs += 60_000
    await service.getSummary()
    expect(claudeUsageMock).toHaveBeenCalledTimes(1)
    expect(fetchCalls.length).toBe(3)

    // Force refresh within 15s of initial fetch is blocked; after 60s it refreshes (but Grok settings stay hourly-cached).
    await service.getSummary({ force: true })
    expect(claudeUsageMock).toHaveBeenCalledTimes(2)
    expect(fetchCalls.filter((c) => c.url.includes('/v1/settings')).length).toBe(1)
  })

  it('enforces HTTP 429 Retry-After backoff even on forced refresh and preserves last known windows', async () => {
    let currentTimeMs = Date.parse('2026-11-26T18:00:00.000Z')
    let calls = 0
    const fetchMock = mock(async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 44, limit_window_seconds: 18_000, reset_after_seconds: 7200 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '600' },
      })
    })

    const service = new OfficialUsageService({
      now: () => currentTimeMs,
      fetchImpl: fetchMock as unknown as typeof fetch,
      getProxyUrl: async () => null,
      getClaudeTokens: async () => null,
      getOpenAITokens: async () => ({
        accessToken: 'oa-tok-429',
        refreshToken: null,
        expiresAt: currentTimeMs + 3_600_000,
        email: 'user@example.com',
        accountId: 'acct_429',
      }),
      getGrokTokens: async () => null,
      getDeepSeekStatus: async () => ({ loggedIn: false }),
      aggregateLocalTokens: async () => ({
        windowHours: 5,
        since: '2026-11-26T13:00:00.000Z',
        until: '2026-11-26T18:00:00.000Z',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turnCount: 0,
        sessionCount: 0,
        byModel: [],
      }),
    })

    await service.getSummary()
    currentTimeMs += 6 * 60 * 1000
    const second = await service.getSummary()
    const openai = second.providers.find((p) => p.providerId === 'openai-official')!
    expect(openai.status).toBe('rate_limited')
    expect(openai.rateLimitedUntil).toBe(new Date(currentTimeMs + 600_000).toISOString())
    expect(openai.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 44, remainingPercent: 56 })

    // Even forced refresh inside Retry-After window must not call upstream again.
    currentTimeMs += 120_000
    await service.getSummary({ force: true })
    expect(calls).toBe(2)
  })

  it('invalidates cache on rotated tokens sharing a prefix, caches local scans for 30s, and throttles unavailable force refresh', async () => {
    let currentTimeMs = Date.parse('2026-11-26T18:00:00.000Z')
    let claudeToken = 'sk-ant-oat01-account-A-token'
    let failClaude = true
    const claudeUsageMock = mock(async () => {
      if (failClaude) {
        return {
          available: false as const,
          fetchedAt: new Date(currentTimeMs).toISOString(),
          reason: 'request_failed' as const,
          status: 503,
        }
      }
      return {
        available: true as const,
        fetchedAt: new Date(currentTimeMs).toISOString(),
        usage: {
          five_hour: { utilization: 12, resets_at: '2026-11-26T20:00:00.000Z' },
        },
      }
    })
    const localScanMock = mock(async (now: Date) => ({
      windowHours: 5,
      since: new Date(now.getTime() - 5 * 3600_000).toISOString(),
      until: now.toISOString(),
      totalTokens: 5000,
      inputTokens: 3000,
      outputTokens: 2000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      turnCount: 1,
      sessionCount: 1,
      byModel: [],
    }))

    const service = new OfficialUsageService({
      now: () => currentTimeMs,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      getProxyUrl: async () => null,
      getClaudeTokens: async () => ({ accessToken: claudeToken, subscriptionType: 'pro' }),
      getClaudePlanUsage: claudeUsageMock,
      getOpenAITokens: async () => null,
      getGrokTokens: async () => null,
      getDeepSeekStatus: async () => ({ loggedIn: false }),
      aggregateLocalTokens: localScanMock,
    })

    const first = await service.getSummary()
    expect(first.providers.find((p) => p.providerId === 'claude-official')?.status).toBe('unavailable')
    expect(claudeUsageMock).toHaveBeenCalledTimes(1)
    expect(localScanMock).toHaveBeenCalledTimes(1)

    // Within 15s cooldown: even force refresh on unavailable status should not spam upstream,
    // while non-forced read within 30s reuses cached local token scan.
    currentTimeMs += 5_000
    await service.getSummary()
    expect(localScanMock).toHaveBeenCalledTimes(1)
    await service.getSummary({ force: true })
    expect(claudeUsageMock).toHaveBeenCalledTimes(1)
    expect(localScanMock).toHaveBeenCalledTimes(2)

    // Rotating to a different token that shares the 13-char `sk-ant-oat01-` prefix must bypass cache immediately.
    claudeToken = 'sk-ant-oat01-account-B-token'
    failClaude = false
    const rotated = await service.getSummary()
    expect(claudeUsageMock).toHaveBeenCalledTimes(2)
    expect(rotated.providers.find((p) => p.providerId === 'claude-official')?.status).toBe('ok')
  })
})

describe('aggregateRollingLocalTokens', () => {
  it('sums only assistant usage inside the rolling 5-hour window and deduplicates chunks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-rolling-tokens-'))
    tempDirs.push(dir)
    const projectDir = path.join(dir, 'demo-project')
    await fs.mkdir(projectDir, { recursive: true })

    const now = new Date('2026-11-26T18:00:00.000Z')
    const recentTs = '2026-11-26T16:30:00.000Z'
    const staleTs = '2026-11-26T10:00:00.000Z'

    const lines = [
      // Duplicate chunk for same requestId/messageId should only count the max/increment, not double-count.
      JSON.stringify({
        type: 'assistant',
        version: '2.1.0',
        sessionId: 'sess-1',
        requestId: 'req-1',
        timestamp: recentTs,
        message: {
          id: 'msg-1',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        version: '2.1.0',
        sessionId: 'sess-1',
        requestId: 'req-1',
        timestamp: recentTs,
        message: {
          id: 'msg-1',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1000, output_tokens: 450, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
        },
      }),
      // Older than 5 hours: excluded.
      JSON.stringify({
        type: 'assistant',
        version: '2.1.0',
        sessionId: 'sess-1',
        requestId: 'req-old',
        timestamp: staleTs,
        message: {
          id: 'msg-old',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 99_999, output_tokens: 99_999 },
        },
      }),
    ]
    const filePath = path.join(projectDir, 'sess-1.jsonl')
    await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf-8')
    await fs.utimes(filePath, now, now)

    const result = await aggregateRollingLocalTokens({ windowHours: 5, now, projectsDir: dir })
    expect(result.inputTokens).toBe(1000)
    expect(result.outputTokens).toBe(450)
    expect(result.cacheReadTokens).toBe(500)
    expect(result.cacheCreationTokens).toBe(100)
    expect(result.totalTokens).toBe(2050)
    expect(result.turnCount).toBe(1)
    expect(result.sessionCount).toBe(1)
    expect(result.byModel[0]?.model).toBe('claude-sonnet-4-6')
  })

  it('reads the tail of oversized transcripts instead of skipping them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-rolling-large-'))
    tempDirs.push(dir)
    const projectDir = path.join(dir, 'large-project')
    await fs.mkdir(projectDir, { recursive: true })

    const now = new Date('2026-11-26T18:00:00.000Z')
    const oldPadding = JSON.stringify({
      type: 'user',
      timestamp: '2026-11-25T10:00:00.000Z',
      text: 'x'.repeat(2048),
    })
    const recentEntry = JSON.stringify({
      type: 'assistant',
      version: '2.1.0',
      sessionId: 'sess-large',
      requestId: 'req-tail',
      timestamp: '2026-11-26T17:30:00.000Z',
      message: {
        id: 'msg-tail',
        model: 'gpt-5.4',
        usage: { input_tokens: 700, output_tokens: 300 },
      },
    })
    const filePath = path.join(projectDir, 'sess-large.jsonl')
    await fs.writeFile(filePath, `${oldPadding}\n${oldPadding}\n${recentEntry}\n`, 'utf-8')
    await fs.utimes(filePath, now, now)

    const result = await aggregateRollingLocalTokens({
      windowHours: 5,
      now,
      projectsDir: dir,
      maxFullReadBytes: 1024,
      tailReadBytes: 1024,
    })
    expect(result.totalTokens).toBe(1000)
    expect(result.turnCount).toBe(1)
    expect(result.byModel[0]?.model).toBe('gpt-5.4')
  })
})

describe('usage-summary router remote-browser isolation', () => {
  it('blocks /api/usage-summary from remote browsers', async () => {
    const req = new Request('http://127.0.0.1:3000/api/usage-summary', { method: 'GET' })
    const res = await handleApiRequest(req, new URL(req.url), { remoteBrowser: true })
    expect(res.status).toBe(403)
  })
})

describe('usageWidgetAccessPolicy', () => {
  it('allows only health, usage-summary GET, and usage-widget preferences GET/PUT', () => {
    const allow = [
      ['GET', 'http://127.0.0.1:3000/health'],
      ['GET', 'http://127.0.0.1:3000/api/usage-summary'],
      ['GET', 'http://127.0.0.1:3000/api/desktop-ui/preferences/usage-widget'],
      ['PUT', 'http://127.0.0.1:3000/api/desktop-ui/preferences/usage-widget'],
    ] as const
    for (const [method, rawUrl] of allow) {
      const req = new Request(rawUrl, { method })
      expect(isUsageWidgetHttpRequestAllowed(req, new URL(rawUrl))).toBe(true)
    }

    const deny = [
      ['POST', 'http://127.0.0.1:3000/api/usage-summary'],
      ['GET', 'http://127.0.0.1:3000/api/sessions'],
      ['GET', 'http://127.0.0.1:3000/ws/session-1'],
      ['PUT', 'http://127.0.0.1:3000/api/desktop-ui/preferences/pet'],
      ['GET', 'http://127.0.0.1:3000/api/providers'],
    ] as const
    for (const [method, rawUrl] of deny) {
      const req = new Request(rawUrl, { method })
      expect(isUsageWidgetHttpRequestAllowed(req, new URL(rawUrl))).toBe(false)
    }
  })
})
