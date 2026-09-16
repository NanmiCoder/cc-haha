import { connectToServer, fetchToolsForClient, clearServerCache } from '../mcp/client.js'
import { performMCPOAuthFlow, clearServerTokensFromLocalStorage, clearMcpClientConfig } from '../mcp/auth.js'
import type { McpHTTPServerConfig, McpSSEServerConfig, ScopedMcpServerConfig } from '../mcp/types.js'
import { savePluginOptions, loadPluginOptions, deletePluginOptions, type PluginOptionSchema, type PluginOptionValues } from '../../utils/plugins/pluginOptionsStorage.js'
import { resolvePluginMcpEnvironment } from '../../utils/plugins/mcpPluginIntegration.js'

import type { RemoteConnectorRecipe } from './types.js'
export type { RemoteConnectorRecipe } from './types.js'

export type RemoteConnectorCheck = { authenticated: boolean, verification: 'remote', toolCount: number }
type RemoteConfig = McpHTTPServerConfig | McpSSEServerConfig
export type RemoteConnectorDependencies = {
  probe: (name: string, config: ScopedMcpServerConfig, signal: AbortSignal) => Promise<{ status: 'connected' | 'needs-auth' | 'failed' | 'disabled', toolCount: number }>
  oauth: (name: string, config: RemoteConfig, onUrl: (url: string) => void, signal: AbortSignal) => Promise<void>
  disconnect: (name: string, config: ScopedMcpServerConfig) => Promise<void>
  loadOptions: (pluginId: string) => PluginOptionValues
  saveOptions: (pluginId: string, values: PluginOptionValues, schema: PluginOptionSchema) => void
  deleteOptions: (pluginId: string) => void
  clearOAuth: (name: string, config: RemoteConfig) => void
}

function ownedName(recipe: RemoteConnectorRecipe): string {
  if (!/^[a-z][a-z0-9-]*$/.test(recipe.id) || recipe.pluginId !== `office-${recipe.id}@haha-connectors`) throw new Error('Invalid managed remote connector identity')
  return `office-${recipe.id}`
}

function validateRecipe(recipe: RemoteConnectorRecipe): void {
  ownedName(recipe)
  const endpoint = new URL(recipe.endpoint)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || recipe.endpoint.includes('${')) throw new Error('Remote connector requires an official HTTPS endpoint')
  if (!['http', 'sse'].includes(recipe.transport)) throw new Error('Unsupported remote connector transport')
  if (recipe.auth.type === 'api-key') {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(recipe.auth.name)) throw new Error('Invalid remote connector credential field')
    if (/[\r\n]/.test(recipe.auth.prefix ?? '')) throw new Error('Invalid remote connector credential prefix')
  }
}

const apiKeySchema: PluginOptionSchema = {
  apiKey: { type: 'string', title: 'API Key', description: 'Service API key for this connector', sensitive: true, required: true },
}

export function buildRemotePlugin(recipe: RemoteConnectorRecipe) {
  validateRecipe(recipe)
  const config: RemoteConfig = { type: recipe.transport, url: recipe.endpoint }
  if (recipe.auth.type === 'oauth' && recipe.auth.clientId) config.oauth = { clientId: recipe.auth.clientId }
  if (recipe.auth.type === 'api-key') {
    const placeholder = '${user_config.apiKey}'
    if (recipe.auth.in === 'header') config.headers = { [recipe.auth.name]: `${recipe.auth.prefix ?? ''}${placeholder}` }
    else {
      // URLSearchParams would percent-encode the substitution marker itself.
      // Encode only the parameter name here. The saved value is URI encoded.
      const url = new URL(recipe.endpoint)
      url.searchParams.delete(recipe.auth.name)
      config.url = `${url.toString()}${url.search ? '&' : '?'}${encodeURIComponent(recipe.auth.name)}=${placeholder}`
    }
  }
  return {
    manifest: { name: ownedName(recipe), version: recipe.version, description: `Managed ${recipe.id} connector`, ...(recipe.auth.type === 'api-key' ? { userConfig: apiKeySchema } : {}) },
    mcpConfig: { mcpServers: { service: config } },
  }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal, cancel: () => Promise<void>): Promise<T> {
  signal.throwIfAborted()
  let listener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => { void cancel().catch(() => {}); reject(new Error('Remote connector operation cancelled or timed out')) }
    signal.addEventListener('abort', listener, { once: true })
    if (signal.aborted) listener()
  })
  try { return await Promise.race([work, aborted]) }
  finally { if (listener) signal.removeEventListener('abort', listener) }
}

const defaultDependencies: RemoteConnectorDependencies = {
  async probe(name, config, signal) {
    signal.throwIfAborted()
    const work = (async () => {
      const client = await connectToServer(name, config)
      if (client.type !== 'connected') return { status: client.type === 'needs-auth' ? 'needs-auth' as const : client.type === 'disabled' ? 'disabled' as const : 'failed' as const, toolCount: 0 }
      const tools = await fetchToolsForClient(client)
      return { status: 'connected' as const, toolCount: tools.length }
    })()
    return abortable(work, signal, () => clearServerCache(name, config))
  },
  oauth: (name, config, onUrl, signal) => performMCPOAuthFlow(name, config, onUrl, signal, { skipBrowserOpen: true }),
  disconnect: clearServerCache,
  loadOptions: loadPluginOptions,
  saveOptions: savePluginOptions,
  deleteOptions: deletePluginOptions,
  clearOAuth(name, config) {
    clearServerTokensFromLocalStorage(name, config)
    clearMcpClientConfig(name, config)
  },
}

export function saveRemoteApiKey(recipe: RemoteConnectorRecipe, rawKey: string, dependencies: RemoteConnectorDependencies = defaultDependencies): void {
  validateRecipe(recipe)
  if (recipe.auth.type !== 'api-key') throw new Error('This connector does not use an API key')
  const key = rawKey.trim()
  if (!key || key.length > 8192 || /[\u0000-\u001f\u007f]/.test(key) || key.includes('${')) throw new Error('A valid connector API key is required')
  // Query values must be encoded before the existing plugin substitution path;
  // both the probe and normal plugin loader read this same sensitive slot.
  dependencies.saveOptions(recipe.pluginId, { apiKey: recipe.auth.in === 'query' ? encodeURIComponent(key) : key }, apiKeySchema)
}

export function createRemoteConnectorBridge(recipe: RemoteConnectorRecipe, dependencies: RemoteConnectorDependencies = defaultDependencies) {
  const template = buildRemotePlugin(recipe).mcpConfig.mcpServers.service
  const serverName = `plugin:${ownedName(recipe)}:service`
  function isConfigured(): boolean {
    if (recipe.auth.type !== 'api-key') return true
    const options = dependencies.loadOptions(recipe.pluginId)
    return typeof options.apiKey === 'string' && Boolean(options.apiKey)
  }
  function config(): ScopedMcpServerConfig & RemoteConfig {
    if (!isConfigured()) throw new Error('Configure the connector API key first')
    const resolved = resolvePluginMcpEnvironment(template, { path: '', source: recipe.pluginId }, dependencies.loadOptions(recipe.pluginId)) as RemoteConfig
    return { ...resolved, scope: 'dynamic', pluginSource: recipe.pluginId }
  }
  return {
    serverName,
    isConfigured,
    async check(signal: AbortSignal): Promise<RemoteConnectorCheck> {
      const remote = config()
      let result: Awaited<ReturnType<RemoteConnectorDependencies['probe']>>
      try {
        signal.throwIfAborted()
        // Explicit checks must not reuse a cached connection/tool list: this
        // revalidates the same owned server without invoking business tools.
        await dependencies.disconnect(serverName, remote)
        signal.throwIfAborted()
        result = await dependencies.probe(serverName, remote, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
      }
      catch { throw new Error('Remote connector connection or tool discovery failed') }
      if (result.status === 'needs-auth') return { authenticated: false, verification: 'remote', toolCount: 0 }
      if (result.status !== 'connected' || result.toolCount < 1) throw new Error('Unable to connect to the remote connector')
      return { authenticated: true, verification: 'remote', toolCount: result.toolCount }
    },
    async authenticate(signal: AbortSignal, progress: (phase: string, authUrl?: string) => void): Promise<void> {
      if (recipe.auth.type !== 'oauth') { if (!isConfigured()) throw new Error('Configure the connector API key first'); return }
      progress('authorizing')
      const remote = config()
      try { await dependencies.oauth(serverName, remote, (candidate) => {
        const url = new URL(candidate)
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid remote connector authorization URL')
        progress('awaiting-authorization', url.toString())
      }, AbortSignal.any([signal, AbortSignal.timeout(300_000)])) }
      catch { throw new Error('Remote connector authorization did not complete') }
      await dependencies.disconnect(serverName, remote)
    },
    async deactivate(): Promise<void> {
      if (isConfigured()) await dependencies.disconnect(serverName, config())
    },
    async removeCredentials(): Promise<void> {
      // Identity was validated as an application-owned plugin. No user/global
      // MCP config is deleted and no remote service-wide revoke is performed.
      if (isConfigured()) {
        const remote = config()
        await dependencies.disconnect(serverName, remote)
        if (recipe.auth.type === 'oauth') dependencies.clearOAuth(serverName, remote)
      }
      dependencies.deleteOptions(recipe.pluginId)
    },
  }
}
