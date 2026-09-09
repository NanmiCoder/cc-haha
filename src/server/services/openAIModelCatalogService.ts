import {
  getOpenAICodexModelCatalog,
  OPENAI_CODEX_MODELS_ENDPOINT,
} from '../../services/openaiAuth/modelCatalog.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import {
  getNetworkProxyFetchOptions,
  loadNetworkSettings,
} from './networkSettings.js'

export async function getDesktopOpenAIModelCatalog(options?: {
  forceRefresh?: boolean
}) {
  const storedTokens = await hahaOpenAIOAuthService.loadTokens()
  const accountKey = storedTokens
    ? storedTokens.accountId ?? storedTokens.email ?? 'authenticated-default'
    : 'logged-out'
  const fetchWithNetworkSettings: typeof fetch = async (input, init) => {
    const settings = await loadNetworkSettings()
    return globalThis.fetch(input, {
      ...getNetworkProxyFetchOptions(settings, OPENAI_CODEX_MODELS_ENDPOINT),
      ...init,
    })
  }

  return getOpenAICodexModelCatalog({
    accountKey,
    fetchOverride: fetchWithNetworkSettings,
    tokenProvider: async () => {
      const tokens = await hahaOpenAIOAuthService.ensureFreshTokens()
      return tokens
        ? {
            accessToken: tokens.accessToken,
            ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
          }
        : null
    },
    ...(options?.forceRefresh
      ? { forceRefresh: true, throwOnForceRefreshError: true }
      : {}),
  })
}
