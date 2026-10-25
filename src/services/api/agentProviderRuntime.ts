import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../../server/types/provider.js'
import { attributionHeaderEnvForModel } from '../../server/services/attributionHeaderPolicy.js'
import { isProviderManagedEnvVar } from '../../utils/managedEnvConstants.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getProviderRuntimeEnvironment, type ProviderRuntimeContext } from './providerRuntimeContext.js'

const inheritedCredentialKeys = new Set([
  'CLAUDE_CODE_API_KEY_HELPER',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CCR_OAUTH_TOKEN_FILE',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_SESSION_INGRESS_TOKEN',
  'OPENAI_CODEX_MODEL',
  'OPENAI_CODEX_HAIKU_MODEL',
  'OPENAI_CODEX_SONNET_MODEL',
  'OPENAI_CODEX_OPUS_MODEL',
  'OPENAI_CODEX_FABLE_MODEL',
  'OPENAI_CODEX_REASONING_EFFORT',
  'CC_HAHA_OPENAI_FAST_MODE',
])

function sanitizedEnvironment(source: Readonly<NodeJS.ProcessEnv>, managedKeys: Set<string>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => (
    !key.toUpperCase().startsWith('ANTHROPIC_') &&
    !isProviderManagedEnvVar(key) &&
    !managedKeys.has(key) &&
    !inheritedCredentialKeys.has(key)
  )))
}

function hostProxyOrigin(source: Readonly<NodeJS.ProcessEnv>): string | undefined {
  let endpoint = source.CC_HAHA_DESKTOP_SERVER_URL
  if (!endpoint && isEnvTruthy(source.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) && source.ANTHROPIC_BASE_URL) {
    const base = new URL(source.ANTHROPIC_BASE_URL)
    if (base.pathname === '/proxy' || /^\/proxy\/providers\/[^/]+\/?$/.test(base.pathname)) {
      endpoint = base.origin
    }
  }
  if (!endpoint) return undefined
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Agent providers require a loopback desktop proxy')
  }
  // The host's local-access credential is accepted only on this loopback name.
  return `http://127.0.0.1${url.port ? `:${url.port}` : ''}`
}

/** Resolve one explicit provider without activating it or mutating process.env. */
export async function resolveAgentProviderRuntime(
  providerId: string,
  source: Readonly<NodeJS.ProcessEnv> = getProviderRuntimeEnvironment(),
): Promise<ProviderRuntimeContext> {
  // Agent tools are also imported while ProviderService initializes its model
  // helpers. Load server dependencies only when an explicit agent runs.
  const [{ ProviderService }, { getManagedEnvKeys }] = await Promise.all([
    import('../../server/services/providerService.js'),
    import('../../server/services/providerRuntimeEnv.js'),
  ])
  const providers = new ProviderService()
  const env = sanitizedEnvironment(source, new Set(getManagedEnvKeys()))
  if (providerId === CLAUDE_OFFICIAL_PROVIDER_ID) {
    const { hahaOAuthService } = await import('../../server/services/hahaOAuthService.js')
    const [token, models] = await Promise.all([
      hahaOAuthService.ensureFreshAccessToken(),
      providers.getOfficialProviderModels(providerId),
    ])
    if (!token) throw new Error('Claude Official is signed out; sign in before selecting it for an agent')
    return {
      providerId,
      runtimeKind: 'claude_oauth',
      getClaudeOAuthAccessToken: () => hahaOAuthService.ensureFreshAccessToken(),
      env: {
        ...env,
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CC_HAHA_TRACE_PROVIDER_ID: providerId,
        CC_HAHA_TRACE_PROVIDER_NAME: 'Claude Official',
        CC_HAHA_TRACE_PROVIDER_FORMAT: 'anthropic',
        ANTHROPIC_MODEL: models.main,
        ...(models.fable && { ANTHROPIC_DEFAULT_FABLE_MODEL: models.fable }),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
        ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
        ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
        ...attributionHeaderEnvForModel(models.main),
      },
    }
  }

  // getProvider also rejects a removed id; never substitute the active provider.
  const provider = await providers.getProvider(providerId)
  const runtimeEnv = await providers.getProviderRuntimeEnv(providerId)
  if (runtimeEnv.ANTHROPIC_API_KEY === 'proxy-managed') {
    const hostOrigin = hostProxyOrigin(source)
    let origin = hostOrigin
    if (!origin) {
      const { ensureStandaloneProviderProxy } = await import('../../server/proxy/standaloneProviderProxy.js')
      origin = `http://127.0.0.1:${ensureStandaloneProviderProxy()}`
    }
    runtimeEnv.ANTHROPIC_BASE_URL = `${origin}/proxy/providers/${encodeURIComponent(providerId)}`
    if (hostOrigin) env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  }
  return {
    providerId,
    runtimeKind: provider.runtimeKind ?? 'anthropic_compatible',
    env: {
      ...env, ...runtimeEnv,
      CC_HAHA_TRACE_PROVIDER_ID: providerId,
      CC_HAHA_TRACE_PROVIDER_NAME: provider.name,
      CC_HAHA_TRACE_PROVIDER_FORMAT: provider.apiFormat ?? 'anthropic',
    },
  }
}
