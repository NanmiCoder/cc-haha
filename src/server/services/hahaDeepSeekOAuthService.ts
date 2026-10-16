import { randomBytes, randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { AuthCodeListener } from '../../services/oauth/auth-code-listener.js'
import { generateCodeChallenge } from '../../services/oauth/crypto.js'
import {
  DEEPSEEK_CALLBACK_PATH,
  cancelDeepSeekAuth,
  exchangeDeepSeekCode,
  fetchDeepSeekProfile,
  getDeepSeekPlatformOrigin,
  initDeepSeekAuth,
  logoutDeepSeekAccount,
  resolveDeepSeekClientIdentity,
  type DeepSeekRequestOptions,
} from '../../services/deepseekAuth/client.js'
import {
  normalizeTokenFile,
  writeDeepSeekOAuthTokenFile,
} from '../../services/deepseekAuth/storage.js'
import type {
  DeepSeekClientIdentity,
  DeepSeekOAuthTokens,
} from '../../services/deepseekAuth/types.js'
import { getNetworkProxyUrl, loadNetworkSettings } from './networkSettings.js'

export type DeepSeekOAuthSession = {
  state: string
  codeVerifier: string
  authorizeId: string
  authorizeUrl: string
  redirectUri: string
  identity: DeepSeekClientIdentity
  createdAt: number
  authCodeListener?: AuthCodeListener
  expiresTimer?: ReturnType<typeof setTimeout>
}

export type DeepSeekOAuthStatus =
  | { loggedIn: false }
  | { loggedIn: true; name: string | null; contact: string | null }

const MAX_SESSION_TTL_MS = 10 * 60 * 1000
const LOGOUT_RETRY_DELAYS_MS = [1_000, 2_000]
// How long a successful platform check of the stored grant is trusted, and how
// soon to look again after one that could not reach the platform.
const STATUS_VERIFIED_TTL_MS = 5 * 60 * 1000
const STATUS_UNREACHABLE_TTL_MS = 30 * 1000
const PROFILE_TIMEOUT_MS = 5_000

export const DEEPSEEK_OAUTH_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek Login Success</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#16a34a;margin:0 0 12px}p{color:#666}</style>
</head><body><div class="card"><h1>✓ DeepSeek Login Successful</h1><p>Authorization is complete. You can close this window and return to Claude Code Haha.</p></div><script>setTimeout(() => window.close(), 3000)</script></body></html>`

function renderErrorHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek Login Failed</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#dc2626;margin:0 0 12px}p{color:#666}</style>
</head><body><div class="card"><h1>DeepSeek Login Failed</h1><p>${escapeHtml(message)}</p></div></body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getCcHahaDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'cc-haha')
}

export function getHahaDeepSeekOAuthFilePath(): string {
  return path.join(getCcHahaDir(), 'deepseek-oauth.json')
}

// The device id identifies this installation to the platform. It outlives a
// sign-out so signing in again does not register a new device every time.
function getDeviceFilePath(): string {
  return path.join(getCcHahaDir(), 'deepseek-device.json')
}

export class HahaDeepSeekOAuthService {
  private sessions = new Map<string, DeepSeekOAuthSession>()
  // Bumped by every sign-out and every new login attempt. A code exchange that
  // was already in flight compares it before writing, so it cannot resurrect a
  // grant the user has just removed or superseded.
  private epoch = 0
  private statusCheck: { token: string; checkedAt: number; ttlMs: number } | null = null
  private statusVerification: {
    token: string
    result: Promise<DeepSeekOAuthTokens | null>
  } | null = null

  getOAuthFilePath(): string {
    return getHahaDeepSeekOAuthFilePath()
  }

  async loadTokens(): Promise<DeepSeekOAuthTokens | null> {
    try {
      return normalizeTokenFile(
        JSON.parse(await fs.readFile(this.getOAuthFilePath(), 'utf-8')),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (error instanceof SyntaxError) return null
      throw error
    }
  }

  async saveTokens(tokens: DeepSeekOAuthTokens): Promise<void> {
    writeDeepSeekOAuthTokenFile(this.getOAuthFilePath(), tokens)
  }

  async deleteTokens(): Promise<void> {
    await fs.rm(this.getOAuthFilePath(), { force: true })
  }

  async getStatus(): Promise<DeepSeekOAuthStatus> {
    const stored = await this.loadTokens()
    if (!stored) return { loggedIn: false }
    const tokens = await this.verifyGrant(stored)
    if (!tokens) return { loggedIn: false }
    return {
      loggedIn: true,
      name: tokens.name ?? null,
      contact: tokens.contact ?? null,
    }
  }

  /**
   * The file alone cannot tell that the platform revoked the grant (signed out
   * on another device, password change), so status asks the platform, at most
   * once per TTL. Only an explicit rejection signs the app out: an unreachable
   * platform leaves the stored login as it is.
   */
  private verifyGrant(tokens: DeepSeekOAuthTokens): Promise<DeepSeekOAuthTokens | null> {
    const check = this.statusCheck
    if (
      check &&
      check.token === tokens.token &&
      Date.now() - check.checkedAt < check.ttlMs
    ) {
      return Promise.resolve(tokens)
    }
    const inflight = this.statusVerification
    if (inflight && inflight.token === tokens.token) return inflight.result

    const result = this.checkGrantWithPlatform(tokens).finally(() => {
      if (this.statusVerification?.result === result) this.statusVerification = null
    })
    this.statusVerification = { token: tokens.token, result }
    return result
  }

  private async checkGrantWithPlatform(
    tokens: DeepSeekOAuthTokens,
  ): Promise<DeepSeekOAuthTokens | null> {
    try {
      const profile = await fetchDeepSeekProfile(tokens.token, {
        identity: resolveDeepSeekClientIdentity(),
        timeoutMs: PROFILE_TIMEOUT_MS,
        ...(await this.getRequestOptions()),
      })
      this.statusCheck = {
        token: tokens.token,
        checkedAt: Date.now(),
        ttlMs: STATUS_VERIFIED_TTL_MS,
      }
      if (!tokens.name && !tokens.contact && (profile.name || profile.contact)) {
        const filled: DeepSeekOAuthTokens = {
          ...tokens,
          name: profile.name,
          contact: profile.contact,
        }
        await this.saveTokensIfCurrent(filled)
        return filled
      }
      return tokens
    } catch (error) {
      if ((error as { code?: string }).code === 'unauthorized') {
        this.statusCheck = null
        await this.deleteTokensIfCurrent(tokens.token)
        return null
      }
      this.statusCheck = {
        token: tokens.token,
        checkedAt: Date.now(),
        ttlMs: STATUS_UNREACHABLE_TTL_MS,
      }
      return tokens
    }
  }

  // A login that completed while the check ran must survive the check's result.
  private async saveTokensIfCurrent(tokens: DeepSeekOAuthTokens): Promise<void> {
    const current = await this.loadTokens()
    if (current?.token !== tokens.token) return
    await this.saveTokens(tokens)
  }

  private async deleteTokensIfCurrent(token: string): Promise<void> {
    const current = await this.loadTokens()
    if (current?.token !== token) return
    await this.deleteTokens()
  }

  async startSession(
    options: { locale?: string } = {},
  ): Promise<DeepSeekOAuthSession> {
    this.dispose()
    // Another start or a sign-out during the awaits below bumps the epoch;
    // this attempt must then release what it opened instead of staying
    // registered nowhere with a live listener.
    const epoch = this.epoch
    const codeVerifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const identity = resolveDeepSeekClientIdentity(options.locale)
    const authCodeListener = new AuthCodeListener(DEEPSEEK_CALLBACK_PATH)
    const port = await authCodeListener.start(undefined, '127.0.0.1')
    if (epoch !== this.epoch) {
      authCodeListener.close()
      throw new Error('DeepSeek sign-in was superseded')
    }
    const redirectUri = `http://127.0.0.1:${port}${DEEPSEEK_CALLBACK_PATH}`

    let init
    try {
      init = await initDeepSeekAuth({
        codeChallenge: generateCodeChallenge(codeVerifier),
        state,
        redirectUri,
        identity,
        ...(await this.getRequestOptions()),
      })
    } catch (error) {
      authCodeListener.close()
      throw error
    }

    const session: DeepSeekOAuthSession = {
      state,
      codeVerifier,
      authorizeId: init.authorizeId,
      authorizeUrl: init.authorizeUrl,
      redirectUri,
      identity,
      createdAt: Date.now(),
      authCodeListener,
    }
    if (epoch !== this.epoch) {
      this.abandonSession(session)
      throw new Error('DeepSeek sign-in was superseded')
    }
    // The platform advertises how long the attempt stays valid; never wait
    // longer than that, or than the local ceiling.
    const ttlMs = Math.min(MAX_SESSION_TTL_MS, init.expiresInSeconds * 1000)
    session.expiresTimer = setTimeout(() => {
      if (this.sessions.get(state) === session) {
        this.abandonSession(session)
        this.sessions.delete(state)
      }
    }, ttlMs)
    session.expiresTimer.unref?.()
    this.sessions.set(state, session)
    this.waitForBrowserCallback(session)
    return session
  }

  private waitForBrowserCallback(session: DeepSeekOAuthSession): void {
    const listener = session.authCodeListener
    if (!listener) return
    void listener
      .waitForAuthorization(session.state, async () => {})
      .then(async (code) => {
        try {
          const authorizedUrl = await this.completeSession(code, session.state)
          // The browser lands on the platform's own completion page, and only
          // after the grant is on disk.
          listener.handleSuccessRedirect([], (response) => {
            response.writeHead(302, {
              Location: authorizedUrl,
              'Cache-Control': 'no-store',
            })
            response.end()
          })
        } catch (error) {
          console.debug(
            '[HahaDeepSeekOAuthService] login failed:',
            error instanceof Error ? error.message : error,
          )
          listener.handleSuccessRedirect([], (response) => {
            response.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            response.end(
              renderErrorHtml(
                'Sign-in failed. Close this tab and try again in Claude Code Haha.',
              ),
            )
          })
        } finally {
          this.closeSession(session)
          this.sessions.delete(session.state)
        }
      })
      .catch(() => {
        // The listener gave up (invalid callback or an error redirect): the
        // attempt can no longer complete, so release it on the platform too.
        if (this.sessions.get(session.state) === session) {
          this.abandonSession(session)
          this.sessions.delete(session.state)
        }
      })
  }

  /** Exchange the callback code, persist the grant, and return the browser's completion URL. */
  async completeSession(code: string, state: string): Promise<string> {
    const session = this.sessions.get(state)
    if (!session || Date.now() - session.createdAt > MAX_SESSION_TTL_MS) {
      throw new Error('DeepSeek OAuth session not found or expired')
    }
    this.sessions.delete(state)
    const epoch = this.epoch
    const deviceId = await this.getDeviceId()
    const identity = session.identity
    const exchange = await exchangeDeepSeekCode({
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: session.redirectUri,
      deviceId,
      identity,
      ...(await this.getRequestOptions()),
    })
    let { name, contact } = exchange
    if (!name && !contact) {
      // The exchange response may omit the user; the display name is
      // best effort and never fails the login.
      const profile = await fetchDeepSeekProfile(exchange.token, {
        identity,
        timeoutMs: PROFILE_TIMEOUT_MS,
        ...(await this.getRequestOptions()),
      }).catch(() => null)
      if (profile) ({ name, contact } = profile)
    }
    const tokens: DeepSeekOAuthTokens = {
      token: exchange.token,
      issuer: getDeepSeekPlatformOrigin(),
      deviceId,
      name,
      contact,
    }
    // The token now exists on the platform. If the user signed out or started
    // another login while the exchange ran, or the write fails, it must not be
    // left valid with nothing holding it.
    if (epoch !== this.epoch) {
      void this.revokeRemotely(tokens)
      throw new Error('DeepSeek sign-in was superseded')
    }
    try {
      await this.saveTokens(tokens)
    } catch (error) {
      void this.revokeRemotely(tokens)
      throw error
    }
    return exchange.authorizedUrl
  }

  /**
   * Remove the grant locally first, so a failed or slow network call can never
   * leave the app signed in, then end the platform session in the background.
   */
  async logout(): Promise<void> {
    this.dispose()
    const tokens = await this.loadTokens()
    await this.deleteTokens()
    if (!tokens) return
    void this.revokeRemotely(tokens)
  }

  dispose(): void {
    this.epoch += 1
    for (const session of this.sessions.values()) this.abandonSession(session)
    this.sessions.clear()
  }

  private async revokeRemotely(tokens: DeepSeekOAuthTokens): Promise<void> {
    const identity = resolveDeepSeekClientIdentity()
    for (let attempt = 0; ; attempt++) {
      try {
        await logoutDeepSeekAccount(tokens.token, {
          identity,
          ...(await this.getRequestOptions()),
        })
        return
      } catch (error) {
        // A rejected token is already logged out on the platform side.
        const code = (error as { code?: string }).code
        const delay = LOGOUT_RETRY_DELAYS_MS[attempt]
        if (code === 'unauthorized' || delay === undefined) {
          console.debug(
            '[HahaDeepSeekOAuthService] remote logout not confirmed:',
            code ?? error,
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, delay).unref?.())
      }
    }
  }

  private abandonSession(session: DeepSeekOAuthSession): void {
    this.closeSession(session)
    // Only an attempt whose code was never exchanged still needs cancelling;
    // failure never reverses the local cancellation.
    void this.getRequestOptions()
      .then((options) =>
        cancelDeepSeekAuth({
          authorizeId: session.authorizeId,
          codeVerifier: session.codeVerifier,
          identity: session.identity,
          ...options,
        }),
      )
      .catch(() => undefined)
  }

  private closeSession(session: DeepSeekOAuthSession): void {
    if (session.expiresTimer) clearTimeout(session.expiresTimer)
    session.expiresTimer = undefined
    session.authCodeListener?.close()
    session.authCodeListener = undefined
  }

  private async getDeviceId(): Promise<string> {
    const filePath = getDeviceFilePath()
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as {
        id?: unknown
      }
      if (typeof parsed.id === 'string' && parsed.id) return parsed.id
    } catch {
      // Missing or unreadable: mint a new one below.
    }
    const id = randomUUID()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, `${JSON.stringify({ id })}\n`, { mode: 0o600 })
    return id
  }

  async getRequestOptions(): Promise<DeepSeekRequestOptions> {
    const settings = await loadNetworkSettings()
    return { proxyUrl: getNetworkProxyUrl(settings) }
  }
}

export const hahaDeepSeekOAuthService = new HahaDeepSeekOAuthService()
