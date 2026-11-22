import { getGrokModelCatalog, readCachedGrokModelCatalog } from '../../services/grokAuth/modelCatalog.js'
import { GROK_MODEL_CATALOG } from '../../services/grokAuth/models.js'
import { oauthTokenIdentity } from '../../services/oauth/refresh-coordinator.js'
import { hahaGrokOAuthService } from './hahaGrokOAuthService.js'
import { getNetworkProxyUrl, loadNetworkSettings } from './networkSettings.js'

/** Share the desktop account and network policy between settings and runtime selection. */
export async function getDesktopGrokModelCatalog(options?: {
  fetchOverride?: typeof fetch
  forceRefresh?: boolean
  waitForInitial?: boolean
  throwOnError?: boolean
}) {
  // A blocking lookup must follow a login change before returning account-specific
  // models or reporting an upstream error from the previous login.
  const verifyAccount = options?.forceRefresh || options?.waitForInitial
  for (let attempt = 0; attempt < 2; attempt++) {
    const tokenFile = hahaGrokOAuthService.getOAuthFilePath()
    const tokens = await hahaGrokOAuthService.ensureFreshTokens().catch(() => null)
    const result = await getGrokModelCatalog({
      ...options,
      // Explicit null prevents a logged-out desktop from using CLI credentials.
      accessToken: tokens?.accessToken ?? null,
      resolveProxyUrl: async () => getNetworkProxyUrl(await loadNetworkSettings()),
    }).then(models => ({ models }), (error: unknown) => ({ error }))
    if (verifyAccount && tokens) {
      const current = await hahaGrokOAuthService.loadTokens().catch(() => null)
      if (tokenFile !== hahaGrokOAuthService.getOAuthFilePath() ||
        oauthTokenIdentity(tokens) !== oauthTokenIdentity(current)) continue
    }
    if ('models' in result) return result.models
    throw result.error
  }
  if (options?.throwOnError) throw new Error('Grok login changed during model catalog refresh')
  return GROK_MODEL_CATALOG
}

export async function readCachedDesktopGrokModelCatalog() {
  const tokens = await hahaGrokOAuthService.loadTokens().catch(() => null)
  return readCachedGrokModelCatalog(tokens?.accessToken ?? null)
}
