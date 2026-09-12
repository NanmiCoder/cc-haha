import {
  getOpenAICodexModelCatalog,
  OPENAI_CODEX_MODELS_ENDPOINT,
} from '../../services/openaiAuth/modelCatalog.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { getNetworkProxyFetchOptions, loadNetworkSettings } from './networkSettings.js'

/** Desktop discovery must use the same account as its official provider runtime. */
export async function getDesktopOpenAICodexModelCatalog(options?: {
  fetchOverride?: typeof fetch
  forceRefresh?: boolean
  throwOnForceRefreshError?: boolean
}) {
  const tokens = await hahaOpenAIOAuthService.loadTokens().catch(() => null)
  const fetchWithNetworkSettings: typeof fetch = async (input, init) => {
    const settings = await loadNetworkSettings()
    return (options?.fetchOverride ?? globalThis.fetch)(input, {
      ...getNetworkProxyFetchOptions(settings, OPENAI_CODEX_MODELS_ENDPOINT),
      ...init,
    })
  }
  return getOpenAICodexModelCatalog({
    ...options,
    tokens,
    fetchOverride: fetchWithNetworkSettings,
    tokenProvider: () => tokens
      ? hahaOpenAIOAuthService.ensureFreshTokens().catch(() => null)
      : Promise.resolve(null),
  })
}
