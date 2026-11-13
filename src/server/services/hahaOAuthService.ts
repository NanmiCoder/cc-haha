/**
 * HahaOAuthService — 桌面端自管 Claude OAuth token
 *
 * 为什么存在: macOS Keychain ACL 在 .app 被打上 quarantine 属性后
 * 对无 UI sidecar 静默拒绝,导致 CLI 读不到 OAuth token → 403。
 * 这个 service 把 token 存到 haha 自己的目录,并通过 env 注入给 CLI。
 *
 * 复用 src/services/oauth/{crypto,client}.ts 里的 PKCE + token exchange 逻辑,
 * 不复制粘贴 —— 保证跟 CLI 走同一套协议实现。
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { logTokenRefreshFailure } from './oauthRefreshLog.js'
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '../../services/oauth/crypto.js'
import axios from 'axios'
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchProfileInfo,
  refreshOAuthToken,
  isOAuthTokenExpired,
  parseScopes,
} from '../../services/oauth/client.js'
import type {
  OAuthTokens,
  OAuthTokenExchangeResponse,
  SubscriptionType,
} from '../../services/oauth/types.js'
import { CLAUDE_AI_PROFILE_SCOPE, getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js'
import type { Utilization } from '../../services/api/usage.js'
import { getAxiosProxyOptions } from '../../utils/proxy.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { getNetworkProxyUrl, loadNetworkSettings } from './networkSettings.js'

export type StoredOAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
}

export type OAuthSession = {
  state: string
  codeVerifier: string
  authorizeUrl: string
  serverPort: number
  createdAt: number
}

type RefreshFn = (
  refreshToken: string,
  opts?: { scopes?: string[]; proxyUrl?: string | null },
) => Promise<OAuthTokens>
type ExchangeFn = (
  authorizationCode: string,
  state: string,
  codeVerifier: string,
  port: number,
  useManualRedirect?: boolean,
  expiresIn?: number,
  opts?: { proxyUrl?: string | null },
) => Promise<OAuthTokenExchangeResponse>
type FetchProfileFn = (
  accessToken: string,
  opts?: { proxyUrl?: string | null },
) => Promise<{ subscriptionType: SubscriptionType | null }>

type FetchAccountUuidFn = (
  accessToken: string,
  opts?: { proxyUrl?: string | null },
) => Promise<string | null>

type FetchPlanUsageFn = (
  accessToken: string,
  opts?: { proxyUrl?: string | null },
) => Promise<Utilization>

/**
 * The Claude subscription's usage limits as the official account reports them
 * (the same data `/usage` shows in the terminal). `fetchedAt` is when this server
 * asked, so the desktop can say how fresh the numbers are.
 */
export type ClaudePlanUsageResult =
  | { available: true; fetchedAt: string; usage: Utilization }
  | {
      available: false
      fetchedAt: string
      reason: 'not_logged_in' | 'missing_scope' | 'request_failed'
      status?: number
    }

const PLAN_USAGE_TIMEOUT_MS = 5_000

export async function fetchClaudePlanUsage(
  accessToken: string,
  opts: { proxyUrl?: string | null } = {},
): Promise<Utilization> {
  const response = await axios.get<Utilization>(
    `${getOauthConfig().BASE_API_URL}/api/oauth/usage`,
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': getClaudeCodeUserAgent(),
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      timeout: PLAN_USAGE_TIMEOUT_MS,
      ...getAxiosProxyOptions(opts.proxyUrl),
    },
  )
  return response.data ?? {}
}

function httpStatusOf(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined
}

const SESSION_TTL_MS = 5 * 60 * 1000
const ACCOUNT_UUID_LOOKUP_TIMEOUT_MS = 3_000
const ACCOUNT_UUID_RETRY_BACKOFF_MS = 60_000

async function fetchAccountUuid(
  accessToken: string,
  opts: { proxyUrl?: string | null } = {},
): Promise<string | null> {
  const profile = await getOauthProfileFromOauthToken(accessToken, opts)
  return profile?.account?.uuid ?? null
}

export class HahaOAuthService {
  private sessions = new Map<string, OAuthSession>()
  private tokenRefreshes = new Map<string, Promise<StoredOAuthTokens | null>>()
  private accountUuid: string | null = null
  private accountUuidRetryAt = 0
  private refreshFn: RefreshFn = refreshOAuthToken
  private exchangeFn: ExchangeFn = exchangeCodeForTokens
  private fetchProfileFn: FetchProfileFn = fetchProfileInfo
  private fetchAccountUuidFn: FetchAccountUuidFn = fetchAccountUuid
  private fetchPlanUsageFn: FetchPlanUsageFn = fetchClaudePlanUsage

  setFetchPlanUsageFn(fn: FetchPlanUsageFn = fetchClaudePlanUsage): void {
    this.fetchPlanUsageFn = fn
  }

  /**
   * Read the logged-in Claude subscription's usage limits. Never throws: the
   * desktop shows why the numbers are unavailable instead of an error dialog.
   */
  async getPlanUsage(): Promise<ClaudePlanUsageResult> {
    const fetchedAt = new Date().toISOString()
    let tokens = await this.ensureFreshTokens().catch(() => null)
    if (!tokens) return { available: false, fetchedAt, reason: 'not_logged_in' }
    // The usage endpoint needs the profile scope, which tokens issued before
    // it was requested do not carry; logging in again grants it.
    if (!tokens.scopes.includes(CLAUDE_AI_PROFILE_SCOPE)) {
      return { available: false, fetchedAt, reason: 'missing_scope' }
    }
    const proxyUrl = getNetworkProxyUrl(await loadNetworkSettings())
    try {
      return { available: true, fetchedAt, usage: await this.fetchPlanUsageFn(tokens.accessToken, { proxyUrl }) }
    } catch (error) {
      let status = httpStatusOf(error)
      // A token revoked or rotated elsewhere: refresh once, as sessions do.
      if (status === 401) {
        const refreshed = await this.recoverFromUnauthorized(tokens.accessToken).catch(() => null)
        if (refreshed && refreshed.accessToken !== tokens.accessToken) {
          tokens = refreshed
          try {
            return { available: true, fetchedAt, usage: await this.fetchPlanUsageFn(tokens.accessToken, { proxyUrl }) }
          } catch (retryError) {
            status = httpStatusOf(retryError)
          }
        }
      }
      return { available: false, fetchedAt, reason: 'request_failed', ...(status ? { status } : {}) }
    }
  }

  setFetchAccountUuidFn(fn: FetchAccountUuidFn = fetchAccountUuid): void {
    this.fetchAccountUuidFn = fn
    this.forgetAccountUuid()
  }

  private forgetAccountUuid(): void {
    this.accountUuid = null
    this.accountUuidRetryAt = 0
  }

  setRefreshFn(fn: RefreshFn): void {
    this.refreshFn = fn
  }

  setExchangeFn(fn: ExchangeFn): void {
    this.exchangeFn = fn
  }

  setFetchProfileFn(fn: FetchProfileFn): void {
    this.fetchProfileFn = fn
  }

  private getOAuthFilePath(): string {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'cc-haha', 'oauth.json')
  }

  async loadTokens(): Promise<StoredOAuthTokens | null> {
    try {
      const raw = await fs.readFile(this.getOAuthFilePath(), 'utf-8')
      return JSON.parse(raw) as StoredOAuthTokens
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const filePath = this.getOAuthFilePath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // 写临时文件再 rename,防止写到一半被其他读者读到残缺 JSON。
    // 单进程 desktop 下 pid 后缀足够隔离。
    const tmp = `${filePath}.tmp.${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 })
    await fs.rename(tmp, filePath)
  }

  async deleteTokens(): Promise<void> {
    this.forgetAccountUuid()
    try {
      await fs.unlink(this.getOAuthFilePath())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  startSession({ serverPort }: { serverPort: number }): OAuthSession {
    this.pruneExpiredSessions()

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    const authorizeUrl = buildAuthUrl({
      codeChallenge,
      state,
      port: serverPort,
      isManual: false,
      loginWithClaudeAi: true,
    })

    const session: OAuthSession = {
      state,
      codeVerifier,
      authorizeUrl,
      serverPort,
      createdAt: Date.now(),
    }
    this.sessions.set(state, session)
    return session
  }

  getSession(state: string): OAuthSession | null {
    const s = this.sessions.get(state)
    if (!s) return null
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(state)
      return null
    }
    return s
  }

  consumeSession(state: string): OAuthSession | null {
    const s = this.getSession(state)
    if (s) this.sessions.delete(state)
    return s
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    for (const [state, s] of this.sessions.entries()) {
      if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(state)
    }
  }

  async completeSession(
    authorizationCode: string,
    state: string,
  ): Promise<StoredOAuthTokens> {
    const session = this.consumeSession(state)
    if (!session) {
      throw new Error('OAuth session not found or expired')
    }

    const response = await this.exchangeWithCustomCallback(
      authorizationCode,
      state,
      session.codeVerifier,
      session.serverPort,
    )
    const networkSettings = await loadNetworkSettings()
    const profile = await this.fetchProfileFn(response.access_token, {
      proxyUrl: getNetworkProxyUrl(networkSettings),
    })

    const tokens: StoredOAuthTokens = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? null,
      expiresAt: Date.now() + response.expires_in * 1000,
      scopes: parseScopes(response.scope),
      subscriptionType: profile.subscriptionType,
    }
    // A new login may be a different account.
    this.forgetAccountUuid()
    await this.saveTokens(tokens)
    return tokens
  }

  /**
   * The same axios request the CLI makes (`exchangeCodeForTokens`), so the wire
   * identity — User-Agent, Accept, body — is the CLI's. Only the proxy comes
   * from the desktop network settings.
   */
  private async exchangeWithCustomCallback(
    code: string,
    state: string,
    verifier: string,
    port: number,
  ): Promise<OAuthTokenExchangeResponse> {
    const networkSettings = await loadNetworkSettings()
    try {
      return await this.exchangeFn(code, state, verifier, port, false, undefined, {
        proxyUrl: getNetworkProxyUrl(networkSettings),
      })
    } catch (err) {
      // axios only reports "Request failed with status code N"; the token
      // endpoint's own error body is what makes a failed login diagnosable.
      if (axios.isAxiosError(err) && err.response) {
        const { status, data } = err.response
        const body = typeof data === 'string' ? data : JSON.stringify(data)
        throw new Error(`Token exchange failed (${status}): ${body}`)
      }
      throw err
    }
  }

  async ensureFreshTokens(): Promise<StoredOAuthTokens | null> {
    const tokens = await this.loadTokens()
    if (!tokens) return null

    if (tokens.expiresAt === null) return tokens

    if (!isOAuthTokenExpired(tokens.expiresAt)) return tokens

    if (!tokens.refreshToken) return null

    return this.refreshTokensOnce(tokens)
  }

  async recoverFromUnauthorized(
    failedAccessToken: string,
  ): Promise<StoredOAuthTokens | null> {
    const rejectedToken = failedAccessToken.trim()
    if (!rejectedToken) return null
    return this.refreshRejectedToken(rejectedToken)
  }

  private async refreshRejectedToken(
    rejectedToken: string,
  ): Promise<StoredOAuthTokens | null> {
    const tokens = await this.loadTokens()
    if (!tokens) return null

    // Another session may already have rotated the shared token while this
    // 401 event was in flight. Reuse that value instead of rotating again.
    if (tokens.accessToken !== rejectedToken) return tokens
    if (!tokens.refreshToken) return null

    return this.refreshTokensOnce(tokens)
  }

  private async refreshTokensOnce(
    tokens: StoredOAuthTokens,
  ): Promise<StoredOAuthTokens | null> {
    const pending = this.tokenRefreshes.get(tokens.accessToken)
    if (pending) return pending

    const refresh = (async () => {
      try {
        return await this.refreshStoredTokens(tokens)
      } catch (err) {
        logTokenRefreshFailure('[HahaOAuthService]', err)
        return null
      }
    })()
    this.tokenRefreshes.set(tokens.accessToken, refresh)
    try {
      return await refresh
    } finally {
      if (this.tokenRefreshes.get(tokens.accessToken) === refresh) {
        this.tokenRefreshes.delete(tokens.accessToken)
      }
    }
  }

  private async refreshStoredTokens(
    tokens: StoredOAuthTokens,
  ): Promise<StoredOAuthTokens> {
    if (!tokens.refreshToken) {
      throw new Error('Claude OAuth refresh token is unavailable')
    }
    const networkSettings = await loadNetworkSettings()
    const refreshed = await this.refreshFn(tokens.refreshToken, {
      scopes: tokens.scopes,
      proxyUrl: getNetworkProxyUrl(networkSettings),
    })
    const updated: StoredOAuthTokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      expiresAt: refreshed.expiresAt,
      scopes: refreshed.scopes,
      subscriptionType: refreshed.subscriptionType ?? tokens.subscriptionType,
    }
    await this.saveTokens(updated)
    return updated
  }

  /**
   * UUID of the account the stored token belongs to, for the CLI child's
   * `metadata.user_id`. A token injected through CLAUDE_CODE_OAUTH_TOKEN has no
   * profile scope on the CLI side, so the CLI cannot look this up itself.
   *
   * Best effort: the answer is cached for the life of the process (it only
   * changes on login or logout), a slow profile endpoint is not allowed to hold
   * up a session start, and any failure just leaves the UUID unset. A failed
   * lookup is not repeated for a while, so an unreachable or refusing endpoint
   * costs one wait rather than one per session.
   */
  async getAccountUuid(accessToken: string): Promise<string | null> {
    if (this.accountUuid) return this.accountUuid
    if (Date.now() < this.accountUuidRetryAt) return null

    // A token issued before `user:profile` was requested is refused by the
    // profile endpoint; do not ask.
    const stored = await this.loadTokens().catch(() => null)
    if (stored && !stored.scopes.includes(CLAUDE_AI_PROFILE_SCOPE)) return null

    const lookup = (async () => {
      const networkSettings = await loadNetworkSettings()
      const uuid = await this.fetchAccountUuidFn(accessToken, {
        proxyUrl: getNetworkProxyUrl(networkSettings),
      })
      // A late answer still warms the cache for the next session.
      if (uuid) this.accountUuid = uuid
      return uuid
    })().catch(() => null)

    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ACCOUNT_UUID_LOOKUP_TIMEOUT_MS).unref?.()
    })
    const uuid = await Promise.race([lookup, timeout])
    if (!uuid) this.accountUuidRetryAt = Date.now() + ACCOUNT_UUID_RETRY_BACKOFF_MS
    return uuid
  }

  async ensureFreshAccessToken(): Promise<string | null> {
    const tokens = await this.ensureFreshTokens()
    return tokens?.accessToken ?? null
  }
}

export const hahaOAuthService = new HahaOAuthService()
