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
  // A blocking lookup must follow a login change before returning account-specific
  // models or reporting an upstream error from the previous login.
  const verifyAccount = options?.forceRefresh || options?.waitForInitial
  for (let attempt = 0; attempt < 2; attempt++) {
    const tokenFile = hahaOpenAIOAuthService.getOAuthFilePath()
    const tokens = await hahaOpenAIOAuthService.ensureFreshTokens().catch(() => null)
    const result = await getOpenAICodexModelCatalog({
      ...options,
      tokens,
      resolveProxyUrl: async () => getNetworkProxyUrl(await loadNetworkSettings()),
    }).then(models => ({ models }), (error: unknown) => ({ error }))
    if (verifyAccount && tokens) {
      const current = await hahaOpenAIOAuthService.loadTokens().catch(() => null)
      if (tokenFile !== hahaOpenAIOAuthService.getOAuthFilePath() ||
        oauthTokenIdentity(tokens) !== oauthTokenIdentity(current)) continue
    }
    if ('models' in result) return result.models
    throw result.error
  }
  if (options?.throwOnError) throw new Error('ChatGPT login changed during model catalog refresh')
  return OPENAI_CODEX_MODEL_CATALOG
}

export async function readCachedDesktopOpenAICodexModelCatalog() {
  const tokens = await hahaOpenAIOAuthService.loadTokens().catch(() => null)
  return readCachedOpenAICodexModelCatalog(tokens)
}
