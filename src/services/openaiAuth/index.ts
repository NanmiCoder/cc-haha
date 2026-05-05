import { openBrowser } from '../../utils/browser.js'
import { AuthCodeListener } from '../oauth/auth-code-listener.js'
import { generateCodeVerifier, generateState } from '../oauth/crypto.js'
import {
  buildOpenAIAuthorizeUrl,
  exchangeOpenAICodeForTokens,
  isOpenAITokenExpired,
  OPENAI_CODEX_OAUTH_PORT,
  OPENAI_CODEX_REDIRECT_PATH,
  refreshOpenAITokens,
  normalizeOpenAITokens,
  withRefreshedAccessToken,
} from './client.js'
import {
  clearOpenAIOAuthTokenCache,
  deleteOpenAIOAuthTokens,
  getOpenAIOAuthTokensAsync,
  saveOpenAIOAuthTokens,
} from './storage.js'
import type { OpenAIOAuthTokens } from './types.js'

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>yuanclaw OpenAI Authorization Successful</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#131010; color:#f1ecec; }
      .container { text-align:center; padding:2rem; }
      p { color:#b7b1b1; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to yuanclaw.</p>
    </div>
    <script>setTimeout(() => window.close(), 2000)</script>
  </body>
</html>`

const HTML_ERROR = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>yuanclaw OpenAI Authorization Failed</title>
  </head>
  <body>
    <h1>Authorization Failed</h1>
    <p>You can close this window and return to yuanclaw.</p>
  </body>
</html>`

export class OpenAIOAuthService {
  private codeVerifier: string
  private authCodeListener: AuthCodeListener | null = null
  private port: number | null = null
  private manualAuthCodeResolver: ((authorizationCode: string) => void) | null =
    null

  constructor() {
    this.codeVerifier = generateCodeVerifier()
  }

  async startOAuthFlow(
    authURLHandler: (url: string, automaticUrl?: string) => Promise<void>,
    options?: {
      skipBrowserOpen?: boolean
    },
  ): Promise<OpenAIOAuthTokens> {
    this.authCodeListener = new AuthCodeListener(OPENAI_CODEX_REDIRECT_PATH)
    this.port = await this.authCodeListener.start(OPENAI_CODEX_OAUTH_PORT)

    const state = generateState()
    const redirectUri = `http://localhost:${this.port}${OPENAI_CODEX_REDIRECT_PATH}`
    const authorizeUrl = buildOpenAIAuthorizeUrl({
      redirectUri,
      codeVerifier: this.codeVerifier,
      state,
    })

    const authorizationCode = await this.waitForAuthorizationCode(
      state,
      async () => {
        if (options?.skipBrowserOpen) {
          await authURLHandler(authorizeUrl, authorizeUrl)
        } else {
          await authURLHandler(authorizeUrl)
          await openBrowser(authorizeUrl)
        }
      },
    )

    try {
      const response = await exchangeOpenAICodeForTokens({
        code: authorizationCode,
        redirectUri,
        codeVerifier: this.codeVerifier,
      })

      const tokens = normalizeOpenAITokens(response)
      const storage = saveOpenAIOAuthTokens(tokens)
      if (!storage.success) {
        throw new Error(storage.warning ?? 'Failed to persist OpenAI OAuth tokens')
      }

      this.authCodeListener?.handleSuccessRedirect([], (res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(HTML_SUCCESS)
      })

      return tokens
    } catch (error) {
      this.authCodeListener?.handleSuccessRedirect([], (res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(HTML_ERROR)
      })
      throw error
    } finally {
      this.cleanup()
    }
  }

  private async waitForAuthorizationCode(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.manualAuthCodeResolver = resolve

      this.authCodeListener
        ?.waitForAuthorization(state, onReady)
        .then((authorizationCode) => {
          this.manualAuthCodeResolver = null
          resolve(authorizationCode)
        })
        .catch((error) => {
          this.manualAuthCodeResolver = null
          reject(error)
        })
    })
  }

  /**
   * Handle manual auth code input — e.g., user pastes the authorization code
   * from the browser into the desktop UI when automatic redirect didn't work.
   */
  handleManualAuthCodeInput(params: {
    authorizationCode: string
    state: string
  }): void {
    if (this.manualAuthCodeResolver) {
      this.manualAuthCodeResolver(params.authorizationCode)
      this.manualAuthCodeResolver = null
      this.authCodeListener?.close()
    }
  }

  async ensureFreshTokens(): Promise<OpenAIOAuthTokens | null> {
    clearOpenAIOAuthTokenCache()
    const tokens = await getOpenAIOAuthTokensAsync()
    if (!tokens) return null
    if (!isOpenAITokenExpired(tokens.expiresAt)) return tokens

    const refreshed = await refreshOpenAITokens(tokens.refreshToken)
    const updated = withRefreshedAccessToken(tokens, refreshed)
    const storage = saveOpenAIOAuthTokens(updated)
    if (!storage.success) {
      throw new Error(storage.warning ?? 'Failed to persist refreshed OpenAI tokens')
    }

    return updated
  }

  async ensureFreshAccessToken(): Promise<string | null> {
  const tokens = await this.ensureFreshTokens()
  return tokens?.accessToken ?? null
  }

  logout(): boolean {
    clearOpenAIOAuthTokenCache()
    return deleteOpenAIOAuthTokens()
  }

  cleanup(): void {
    this.authCodeListener?.close()
    this.authCodeListener = null
    this.port = null
    this.manualAuthCodeResolver = null
  }
}

export async function ensureFreshOpenAITokens(): Promise<OpenAIOAuthTokens | null> {
  clearOpenAIOAuthTokenCache()
  const tokens = await getOpenAIOAuthTokensAsync()
  if (!tokens) return null
  if (!isOpenAITokenExpired(tokens.expiresAt)) return tokens

  try {
    const refreshed = await refreshOpenAITokens(tokens.refreshToken)
    const updated = withRefreshedAccessToken(tokens, refreshed)
    const storage = saveOpenAIOAuthTokens(updated)
    if (!storage.success) {
      throw new Error(storage.warning ?? 'Failed to persist refreshed OpenAI tokens')
    }
    return updated
  } catch {
    return null
  }
}
