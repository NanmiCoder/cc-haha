import { ensureStandaloneProviderProxy } from '../../server/proxy/standaloneProviderProxy.js'
import { attributionHeaderEnvForModel } from '../../server/services/attributionHeaderPolicy.js'
import {
  getNetworkProxyUrl,
  loadNetworkSettings,
  resolveProviderNetworkSettings,
} from '../../server/services/networkSettings.js'
import {
  buildProviderManagedEnv,
  readSavedProviderRuntime,
  resolveProviderApiFormat,
} from '../../server/services/providerRuntimeEnv.js'
import type { ProviderProxyConfig } from '../../server/types/provider.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import type { ProviderRoute } from './providerEnvScope.js'

const ALIAS_SLOT_ENV: Record<string, string> = {
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
}

export class AgentProviderUnavailableError extends Error {
  constructor(agentType: string, providerId: string) {
    super(
      `Agent "${agentType}" is configured to use provider "${providerId}", which is not a saved API provider. ` +
        'Choose an available provider for this Agent in Settings → Agents, or remove its provider.',
    )
    this.name = 'AgentProviderUnavailableError'
  }
}

/**
 * A host-managed CLI reaches format-translating providers through the desktop
 * server's proxy, exactly like a session on that provider. Anywhere else the
 * in-process proxy serves the same handler.
 */
function getHostProxyPort(): number | undefined {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) return undefined
  const serverUrl = process.env.CC_HAHA_DESKTOP_SERVER_URL
  if (!serverUrl) return undefined
  try {
    const port = Number(new URL(serverUrl).port)
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

function resolveRouteModel(env: Record<string, string>, spec: string | undefined): string | undefined {
  const trimmed = spec?.trim()
  const alias = trimmed?.toLowerCase()
  if (!trimmed || alias === 'inherit') return env.ANTHROPIC_MODEL
  const slotEnv = alias ? ALIAS_SLOT_ENV[alias] : undefined
  if (!slotEnv) return trimmed
  return env[slotEnv] || (alias === 'fable' ? env.ANTHROPIC_DEFAULT_OPUS_MODEL : undefined) || env.ANTHROPIC_MODEL
}

/**
 * The session's proxy env was built from the session provider's network
 * override; a provider reached directly needs the global setting with its own.
 */
async function resolveDirectProxyUrl(providerProxy: ProviderProxyConfig | undefined): Promise<string | null | undefined> {
  try {
    return getNetworkProxyUrl(resolveProviderNetworkSettings(await loadNetworkSettings(), providerProxy))
  } catch {
    // An unavailable system-proxy bridge keeps the session's process proxy.
    return undefined
  }
}

export async function resolveAgentProviderRoute({
  agentType,
  providerId,
  model,
}: {
  agentType: string
  providerId: string
  model?: string
}): Promise<ProviderRoute> {
  const saved = readSavedProviderRuntime(getClaudeConfigHomeDir(), providerId)
  if (!saved) throw new AgentProviderUnavailableError(agentType, providerId)
  const { provider } = saved
  const env = buildProviderManagedEnv(provider, {
    proxyPath: `/proxy/providers/${provider.id}`,
    ...(saved.needsProxy ? { serverPort: getHostProxyPort() ?? ensureStandaloneProviderProxy() } : {}),
  })
  const routeModel = resolveRouteModel(env, model)
  if (!routeModel) throw new AgentProviderUnavailableError(agentType, providerId)
  const proxyUrl = saved.needsProxy ? undefined : await resolveDirectProxyUrl(provider.proxy)
  return {
    providerId: provider.id,
    providerName: provider.name,
    model: routeModel,
    env: {
      ...env,
      ANTHROPIC_MODEL: routeModel,
      // The provider env derives this from its main slot; the Agent may use another.
      ...attributionHeaderEnvForModel(routeModel),
      CC_HAHA_TRACE_PROVIDER_ID: provider.id,
      CC_HAHA_TRACE_PROVIDER_NAME: provider.name,
      CC_HAHA_TRACE_PROVIDER_FORMAT: resolveProviderApiFormat(provider),
    },
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
  }
}
