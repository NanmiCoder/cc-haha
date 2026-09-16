import { getOpenAICodexModelCatalog } from '../../services/openaiAuth/modelCatalog.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'

/** Desktop discovery must use the same account as its official provider runtime. */
export async function getDesktopOpenAICodexModelCatalog(options?: {
  fetchOverride?: typeof fetch
  forceRefresh?: boolean
}) {
  const tokens = await hahaOpenAIOAuthService.ensureFreshTokens().catch(() => null)
  return getOpenAICodexModelCatalog({ ...options, tokens })
}
