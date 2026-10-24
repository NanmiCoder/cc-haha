export type ProviderRuntime = 'claude-code' | 'agent-sdk'

type AgentSdkProviderConfig = {
  runtime?: ProviderRuntime
  runtimeKind?: string
  baseUrl: string
  apiFormat?: string
  authStrategy?: string
  apiKey: string
}

/** Keep the official SDK path explicit; third-party endpoints retain the existing runtime. */
export function getAgentSdkProviderError(provider: AgentSdkProviderConfig): string | undefined {
  if (provider.runtime !== 'agent-sdk') return undefined
  let officialEndpoint = false
  try {
    const url = new URL(provider.baseUrl.trim())
    officialEndpoint = url.origin === 'https://api.anthropic.com'
      && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
  } catch {
    // Invalid URLs are rejected by the same actionable configuration error.
  }
  if (!officialEndpoint || (provider.apiFormat ?? 'anthropic') !== 'anthropic'
    || provider.authStrategy !== 'api_key' || !provider.apiKey.trim()
    || (provider.runtimeKind ?? 'anthropic_compatible') !== 'anthropic_compatible') {
    return 'Official Agent SDK requires https://api.anthropic.com, Anthropic Messages, and API Key authentication with an API key.'
  }
  return undefined
}
