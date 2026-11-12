/**
 * HahaOpenAIOAuthService — desktop self-managed OpenAI OAuth token
 *
 * Why this exists: once the .app carries the quarantine attribute, the macOS Keychain ACL
 * silently denies UI-less sidecars, so the CLI cannot read the OAuth token → 403.
 * This service stores the token in haha's own directory and injects it into the CLI via env.
 *
 * Reuses the PKCE + token exchange logic in src/services/openaiAuth/client.ts
 * rather than copy-pasting —— so it follows the same protocol implementation as the CLI.
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { coordinateOAuthRefresh, oauthFileAuthority, oauthTokenIdentity, saveRefreshedOAuthFile } from '../../services/oauth/refresh-coordinator.js'
import { AuthCodeListener } from '../../services/oauth/auth-code-listener.js'
import {
  buildOpenAIAuthorizeUrl,
  exchangeOpenAICodeForTokens,
  generateOpenAICodeVerifier,
  generateOpenAIState,
  refreshOpenAITokens,
  isOpenAITokenExpired,
  normalizeOpenAITokens,
  withRefreshedAccessToken,
  OPENAI_CODEX_REDIRECT_PATH,
  OPENAI_CODEX_OAUTH_PORT,
  type OpenAITokenFetchOptions,
} from '../../services/openaiAuth/client.js'
import type { OpenAIOAuthTokenResponse } from '../../services/openaiAuth/types.js'
import {
  getNetworkProxyUrl,
  loadNetworkSettings,
} from './networkSettings.js'

export type StoredOpenAIOAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  idToken?: string | null
  email: string | null
  accountId: string | null
  clientId?: string | null
}

export type OpenAIOAuthSession = {
  state: string
  codeVerifier: string
  authorizeUrl: string
  redirectUri: string
  createdAt: number
  authCodeListener?: AuthCodeListener
  expiresTimer?: ReturnType<typeof setTimeout>
}

type OpenAIRefreshFn = (
  refreshToken: string,
  options?: OpenAITokenFetchOptions,
) => Promise<OpenAIOAuthTokenResponse>

const SESSION_TTL_MS = 5 * 60 * 1000

const HTML_SUCCESS = `<!doctype html>
<html><head><meta charset="utf-8"><title>OpenAI Login Success</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#16a34a;margin:0 0 12px}p{color:#666}</style>
</head><body><div class="card"><h1>OpenAI Login Successful</h1><p>You can close this window and return to Claude Code Haha.</p></div>
<script>setTimeout(() => window.close(), 1500)</script>
</body></html>`

function renderErrorHtml(message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>OpenAI Login Failed</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}.card{text-align:center;padding:40px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06)}h1{color:#dc2626;margin:0 0 12px}pre{color:#666;white-space:pre-wrap;word-break:break-word;text-align:left;background:#f5f5f5;padding:12px;border-radius:6px}</style>
</head><body><div class="card"><h1>OpenAI Login Failed</h1><pre>${escapeHtml(message)}</pre></div>
</body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function getHahaOpenAIOAuthFilePath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'cc-haha', 'openai-oauth.json')
}

export class HahaOpenAIOAuthService {
  private sessions = new Map<string, OpenAIOAuthSession>()
  private refreshFn: OpenAIRefreshFn = refreshOpenAITokens
  private callbackPort: number

  constructor(options: { callbackPort?: number } = {}) {
    this.callbackPort = options.callbackPort ?? OPENAI_CODEX_OAUTH_PORT
  }

  setRefreshFn(fn: OpenAIRefreshFn): void {
    this.refreshFn = fn
  }

  setCallbackPortForTests(port: number): void {
    this.dispose()
    this.callbackPort = port
  }

  resetCallbackPortForTests(): void {
    this.dispose()
    this.callbackPort = OPENAI_CODEX_OAUTH_PORT
  }

  getOAuthFilePath(): string {
    return getHahaOpenAIOAuthFilePath()
  }

  async loadTokens(): Promise<StoredOpenAIOAuthTokens | null> {
    try {
      const raw = await fs.readFile(this.getOAuthFilePath(), 'utf-8')
      return JSON.parse(raw) as StoredOpenAIOAuthTokens
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async saveTokens(tokens: StoredOpenAIOAuthTokens): Promise<void> {
    const filePath = this.getOAuthFilePath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
    let renamed = false
    try {
      await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 })
      await fs.rename(tmp, filePath)
      renamed = true
    } finally {
      if (!renamed) {
        await fs.rm(tmp, { force: true }).catch(() => {})
      }
    }
  }

  async deleteTokens(): Promise<void> {
    try {
      await fs.unlink(this.getOAuthFilePath())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async startSession(_input: { serverPort: number }): Promise<OpenAIOAuthSession> {
    this.pruneExpiredSessions()
    this.dispose()

    const codeVerifier = generateOpenAICodeVerifier()
    const state = generateOpenAIState()
    const authCodeListener = new AuthCodeListener(OPENAI_CODEX_REDIRECT_PATH)

    try {
      await authCodeListener.start(this.callbackPort)
    } catch (err) {
      authCodeListener.close()
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `OpenAI OAuth callback port ${this.callbackPort} is unavailable: ${message}`,
      )
    }

    const redirectUri = `http://localhost:${this.callbackPort}${OPENAI_CODEX_REDIRECT_PATH}`
    const authorizeUrl = buildOpenAIAuthorizeUrl({
      redirectUri,
      codeVerifier,
      state,
    })

    const session: OpenAIOAuthSession = {
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

  getSession(state: string): OpenAIOAuthSession | null {
    const s = this.sessions.get(state)
    if (!s) return null
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      this.closeSession(s)
      this.sessions.delete(state)
      return null
    }
    return s
  }

  consumeSession(state: string): OpenAIOAuthSession | null {
    const s = this.getSession(state)
    if (s) {
      this.clearSessionTimer(s)
      this.sessions.delete(state)
    }
    return s
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    for (const [state, s] of this.sessions.entries()) {
      if (now - s.createdAt > SESSION_TTL_MS) {
        this.closeSession(s)
        this.sessions.delete(state)
      }
    }
  }

  private waitForDesktopCallback(session: OpenAIOAuthSession): void {
    const listener = session.authCodeListener
    if (!listener) return

    void listener
      .waitForAuthorization(session.state, async () => {})
      .then(async (authorizationCode) => {
        try {
          await this.completeSession(authorizationCode, session.state)
          listener.handleSuccessRedirect([], (res) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(HTML_SUCCESS)
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          listener.handleSuccessRedirect([], (res) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(renderErrorHtml(message))
          })
        } finally {
          this.closeSession(session)
          this.sessions.delete(session.state)
        }
      })
      .catch((err) => {
        if (this.sessions.get(session.state) === session) {
          this.closeSession(session)
          this.sessions.delete(session.state)
        }
        console.error(
          '[HahaOpenAIOAuthService] OAuth callback listener failed:',
          err instanceof Error ? err.message : err,
        )
      })
  }

  private clearSessionTimer(session: OpenAIOAuthSession): void {
    if (session.expiresTimer) {
      clearTimeout(session.expiresTimer)
      session.expiresTimer = undefined
    }
  }

  private closeSession(session: OpenAIOAuthSession): void {
    this.clearSessionTimer(session)
    session.authCodeListener?.close()
    session.authCodeListener = undefined
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      this.closeSession(session)
    }
    this.sessions.clear()
  }

  async completeSession(
    authorizationCode: string,
    state: string,
  ): Promise<StoredOpenAIOAuthTokens> {
    const session = this.consumeSession(state)
    if (!session) {
      throw new Error('OpenAI OAuth session not found or expired')
    }

    const response = await exchangeOpenAICodeForTokens({
      code: authorizationCode,
      redirectUri: session.redirectUri,
      codeVerifier: session.codeVerifier,
      ...(await this.getOpenAITokenFetchOptions()),
    })

    const normalized = normalizeOpenAITokens(response)
    const tokens: StoredOpenAIOAuthTokens = {
      accessToken: normalized.accessToken,
      refreshToken: normalized.refreshToken,
      expiresAt: normalized.expiresAt,
      idToken: normalized.idToken ?? null,
      email: normalized.email ?? null,
      accountId: normalized.accountId ?? null,
      clientId: normalized.clientId ?? null,
    }
    await this.saveTokens(tokens)
    return tokens
  }

  async ensureFreshTokens(): Promise<StoredOpenAIOAuthTokens | null> {
    const filePath = this.getOAuthFilePath()
    const tokens = await this.loadTokens()
    if (this.getOAuthFilePath() !== filePath) throw new Error("OAuth credential store changed during refresh; retry the request")
    if (!tokens) return null

    if (tokens.expiresAt === null) return tokens

    if (!isOpenAITokenExpired(tokens.expiresAt)) return tokens

    if (!tokens.refreshToken) return null

    await coordinateOAuthRefresh('openai', oauthFileAuthority(filePath), tokens, async (assertOwnership) => {
      const current = await this.loadTokens()
      if (this.getOAuthFilePath() !== filePath) throw new Error("OAuth credential store changed during refresh; retry the request")
      if (oauthTokenIdentity(current) !== oauthTokenIdentity(tokens)) {
        if (current && (current.expiresAt === null || !isOpenAITokenExpired(current.expiresAt))) return
        throw new Error("OAuth credentials changed during refresh; retry the request")
      }
      const refreshed = await this.refreshFn(
        tokens.refreshToken,
        await this.getOpenAITokenFetchOptions(),
      )
      const normalized = withRefreshedAccessToken(
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
          ...(tokens.email ? { email: tokens.email } : {}),
          ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
          ...(tokens.clientId ? { clientId: tokens.clientId } : {}),
        },
        refreshed,
      )
      const updated: StoredOpenAIOAuthTokens = {
        accessToken: normalized.accessToken,
        refreshToken: normalized.refreshToken,
        expiresAt: normalized.expiresAt,
        idToken: normalized.idToken ?? null,
        email: normalized.email ?? null,
        accountId: normalized.accountId ?? null,
        clientId: normalized.clientId ?? null,
      }
      if (this.getOAuthFilePath() !== filePath) throw new Error("OAuth credential store changed during refresh; retry the request")
      assertOwnership()
      saveRefreshedOAuthFile(filePath, tokens, updated)
    })
    const updated = await this.loadTokens()
    if (this.getOAuthFilePath() !== filePath) throw new Error("OAuth credential store changed during refresh; retry the request")
    return updated
  }

  async ensureFreshAccessToken(): Promise<string | null> {
    const tokens = await this.ensureFreshTokens()
    return tokens?.accessToken ?? null
  }

  private async getOpenAITokenFetchOptions(): Promise<OpenAITokenFetchOptions> {
    const networkSettings = await loadNetworkSettings()
    return {
      proxyUrl: getNetworkProxyUrl(networkSettings),
      timeoutMs: networkSettings.aiRequestTimeoutMs,
    }
  }
}

export const hahaOpenAIOAuthService = new HahaOpenAIOAuthService()
