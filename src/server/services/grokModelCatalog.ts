import { getGrokModelCatalog } from '../../services/grokAuth/modelCatalog.js'
import { hahaGrokOAuthService } from './hahaGrokOAuthService.js'
import { getNetworkProxyUrl, loadNetworkSettings } from './networkSettings.js'

/** Share the desktop account and network policy between settings and runtime selection. */
export async function getDesktopGrokModelCatalog(options?: {
  fetchOverride?: typeof fetch
  forceRefresh?: boolean
  throwOnError?: boolean
}) {
  const tokens = await hahaGrokOAuthService.ensureFreshTokens().catch(() => null)
  return getGrokModelCatalog({
    ...options,
    // Explicit null prevents a logged-out desktop from using CLI credentials.
    accessToken: tokens?.accessToken ?? null,
    resolveProxyUrl: async () => getNetworkProxyUrl(await loadNetworkSettings()),
  })
}
