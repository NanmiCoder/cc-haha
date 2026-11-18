import { getOpenAICodexModelCatalog, readCachedOpenAICodexModelCatalog } from '../../services/openaiAuth/modelCatalog.js'
import { OPENAI_CODEX_MODEL_CATALOG } from '../../services/openaiAuth/models.js'
import { oauthTokenIdentity } from '../../services/oauth/refresh-coordinator.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { getNetworkProxyUrl, loadNetworkSettings } from './networkSettings.js'

/** Desktop discovery must use the same account as its official provider runtime. */
export async function getDesktopOpenAICodexModelCatalog(options?: {
  fetchOverride?: typeof fetch
  forceRefresh?: boolean
  waitForInitial?: boolean
  throwOnError?: boolean
}) {
  // If credentials change while launch waits on the catalog, resolve once
  // more with the account the CLI's OAuth file now points to.
  for (let attempt = 0; attempt < 2; attempt++) {
    const tokenFile = hahaOpenAIOAuthService.getOAuthFilePath()
    const tokens = await hahaOpenAIOAuthService.ensureFreshTokens().catch(() => null)
    const catalog = await getOpenAICodexModelCatalog({
      ...options,
      tokens,
      resolveProxyUrl: async () => getNetworkProxyUrl(await loadNetworkSettings()),
    })
    if (!options?.waitForInitial || !tokens) return catalog
    const current = await hahaOpenAIOAuthService.loadTokens().catch(() => null)
    if (tokenFile === hahaOpenAIOAuthService.getOAuthFilePath() &&
      oauthTokenIdentity(tokens) === oauthTokenIdentity(current)) return catalog
  }
  return OPENAI_CODEX_MODEL_CATALOG
}

export async function readCachedDesktopOpenAICodexModelCatalog() {
  const tokens = await hahaOpenAIOAuthService.loadTokens().catch(() => null)
  return readCachedOpenAICodexModelCatalog(tokens)
}
