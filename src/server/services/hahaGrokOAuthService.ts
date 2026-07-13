import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { AuthCodeListener } from '../../services/oauth/auth-code-listener.js'
import {
  buildGrokAuthorizeUrl,
  exchangeGrokCodeForTokens,
  generateGrokCodeVerifier,
  generateGrokNonce,
  generateGrokState,
  isGrokTokenExpired,
  normalizeGrokTokens,
  refreshGrokTokens,
  withRefreshedGrokAccessToken,
  type GrokTokenFetchOptions,
} from '../../services/grokAuth/client.js'
import type { GrokOAuthTokenResponse } from '../../services/grokAuth/types.js'
import { logTokenRefreshFailure } from './oauthRefreshLog.js'
import {
  getManualNetworkProxyUrl,
  loadNetworkSettings,
} from './networkSettings.js'

export type StoredGrokOAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  idToken?: string | null
  email: string | null
  clientId?: string | null
}

export type GrokOAuthSession = {
  state: string
  codeVerifier: string
  authorizeUrl: string
  redirectUri: string
  createdAt: number
  authCodeListener?: AuthCodeListener
  expiresTimer?: ReturnType<typeof setTimeout>
}

type GrokRefreshFn = (
  refreshToken: string,
  options?: GrokTokenFetchOptions,
) => Promise<GrokOAuthTokenResponse>

const SESSION_TTL_MS = 10 * 60 * 1000
const CALLBACK_PATH = '/callback'

export const GROK_OAUTH_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Grok Login Success</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#16a34a;margin:0 0 12px}p{color:#666}</style>
</head><body><div class="card"><h1>✓ Grok Login Successful</h1><p>Authorization is complete. You can close this window and return to Claude Code Haha.</p></div><script>setTimeout(() => window.close(), 3000)</script></body></html>`

function renderErrorHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Grok Login Failed</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#dc2626;margin:0 0 12px}pre{color:#666;white-space:pre-wrap;word-break:break-word;text-align:left;background:#f5f5f5;padding:12px;border-radius:6px}</style>
</head><body><div class="card"><h1>Grok Login Failed</h1><pre>${escapeHtml(message)}</pre></div></body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function getHahaGrokOAuthFilePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'cc-haha', 'grok-oauth.json')
}

export class HahaGrokOAuthService {
  private sessions = new Map<string, GrokOAuthSession>()
  private refreshFn: GrokRefreshFn = refreshGrokTokens

  setRefreshFn(fn: GrokRefreshFn): void {
    this.refreshFn = fn
  }

  getOAuthFilePath(): string {
    return getHahaGrokOAuthFilePath()
  }

  async loadTokens(): Promise<StoredGrokOAuthTokens | null> {
    try {
      return JSON.parse(await fs.readFile(this.getOAuthFilePath(), 'utf-8')) as StoredGrokOAuthTokens
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async saveTokens(tokens: StoredGrokOAuthTokens): Promise<void> {
    const filePath = this.getOAuthFilePath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
    let renamed = false
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporaryPath, filePath)
      renamed = true
    } finally {
      if (!renamed) await fs.rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  async deleteTokens(): Promise<void> {
    await fs.rm(this.getOAuthFilePath(), { force: true })
  }

  async startSession(): Promise<GrokOAuthSession> {
    this.dispose()
    const codeVerifier = generateGrokCodeVerifier()
    const state = generateGrokState()
    const nonce = generateGrokNonce()
    const authCodeListener = new AuthCodeListener(CALLBACK_PATH)
    const port = await authCodeListener.start(undefined, '127.0.0.1')
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
    const authorizeUrl = buildGrokAuthorizeUrl({ redirectUri, codeVerifier, state, nonce })
    const session: GrokOAuthSession = {
      state,
      codeVerifier,
      authorizeUrl,
      redirectUri,
      createdAt: Date.now(),
      authCodeListener,
    }
    session.expiresTimer = setTimeout(() => {
      if (this.sessions.get(state) === session) {
        this.closeSession(session)
        this.sessions.delete(state)
      }
    }, SESSION_TTL_MS)
    session.expiresTimer.unref?.()
    this.sessions.set(state, session)
    this.waitForDesktopCallback(session)
    return session
  }

  private waitForDesktopCallback(session: GrokOAuthSession): void {
    const listener = session.authCodeListener
    if (!listener) return
    void listener.waitForAuthorization(session.state, async () => {})
      .then(async (code) => {
        try {
          await this.completeSession(code, session.state)
          listener.handleSuccessRedirect([], (response) => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(GROK_OAUTH_SUCCESS_HTML)
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          listener.handleSuccessRedirect([], (response) => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(renderErrorHtml(message))
          })
        } finally {
          this.closeSession(session)
          this.sessions.delete(session.state)
        }
      })
      .catch(() => {
        this.closeSession(session)
        this.sessions.delete(session.state)
      })
  }

  async completeSession(code: string, state: string): Promise<StoredGrokOAuthTokens> {
    const session = this.sessions.get(state)
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
      throw new Error('Grok OAuth session not found or expired')
    }
    this.sessions.delete(state)
    const response = await exchangeGrokCodeForTokens({
      code,
      redirectUri: session.redirectUri,
      codeVerifier: session.codeVerifier,
      ...(await this.getTokenFetchOptions()),
    })
    const normalized = normalizeGrokTokens(response)
    const tokens: StoredGrokOAuthTokens = {
      accessToken: normalized.accessToken,
      refreshToken: normalized.refreshToken,
      expiresAt: normalized.expiresAt,
      idToken: normalized.idToken ?? null,
      email: normalized.email ?? null,
      clientId: normalized.clientId ?? null,
    }
    await this.saveTokens(tokens)
    return tokens
  }

  async ensureFreshTokens(): Promise<StoredGrokOAuthTokens | null> {
    const tokens = await this.loadTokens()
    if (!tokens) return null
    if (tokens.expiresAt === null || !isGrokTokenExpired(tokens.expiresAt)) return tokens
    if (!tokens.refreshToken) return null
    try {
      const response = await this.refreshFn(tokens.refreshToken, await this.getTokenFetchOptions())
      const normalized = withRefreshedGrokAccessToken({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        ...(tokens.email ? { email: tokens.email } : {}),
        ...(tokens.clientId ? { clientId: tokens.clientId } : {}),
      }, response)
      const updated: StoredGrokOAuthTokens = {
        accessToken: normalized.accessToken,
        refreshToken: normalized.refreshToken,
        expiresAt: normalized.expiresAt,
        idToken: normalized.idToken ?? null,
        email: normalized.email ?? null,
        clientId: normalized.clientId ?? null,
      }
      await this.saveTokens(updated)
      return updated
    } catch (error) {
      logTokenRefreshFailure('[HahaGrokOAuthService]', error)
      return null
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) this.closeSession(session)
    this.sessions.clear()
  }

  private closeSession(session: GrokOAuthSession): void {
    if (session.expiresTimer) clearTimeout(session.expiresTimer)
    session.expiresTimer = undefined
    session.authCodeListener?.close()
    session.authCodeListener = undefined
  }

  private async getTokenFetchOptions(): Promise<GrokTokenFetchOptions> {
    const settings = await loadNetworkSettings()
    return {
      proxyUrl: getManualNetworkProxyUrl(settings),
      timeoutMs: settings.aiRequestTimeoutMs,
    }
  }
}

export const hahaGrokOAuthService = new HahaGrokOAuthService()
