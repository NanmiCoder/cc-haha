import { getOpenAICodexModelCatalog } from '../../services/openaiAuth/modelCatalog.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { getNetworkProxyUrl, loadNetworkSettings } from './networkSettings.js'

/** Desktop discovery must use the same account as its official provider runtime. */
export async function getDesktopOpenAICodexModelCatalog(options?: {
  fetchOverride?: typeof fetch
  forceRefresh?: boolean
  throwOnError?: boolean
}) {
  const tokens = await hahaOpenAIOAuthService.ensureFreshTokens().catch(() => null)
  return getOpenAICodexModelCatalog({
    ...options,
    tokens,
    resolveProxyUrl: async () => getNetworkProxyUrl(await loadNetworkSettings()),
  })
}
