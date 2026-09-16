import { describe, expect, test } from 'bun:test'
import { buildRemotePlugin, createRemoteConnectorBridge, saveRemoteApiKey, type RemoteConnectorDependencies, type RemoteConnectorRecipe } from './remoteConnector.js'
import { resolvePluginMcpEnvironment, addPluginScopeToServers } from '../../utils/plugins/mcpPluginIntegration.js'

const recipe = (auth: RemoteConnectorRecipe['auth']): RemoteConnectorRecipe => ({ id: 'maps-fixture', pluginId: 'office-maps-fixture@haha-connectors', version: '1.0.0', endpoint: 'https://official.example/mcp?format=0', transport: 'http', auth })
function fixture() {
  const options: Record<string, Record<string, string>> = { 'another-plugin@other': { apiKey: 'keep-other-secret' } }
  const calls: Array<{ kind: string, name: string, config?: unknown }> = []
  const dependencies: RemoteConnectorDependencies = {
    async probe(name, config, signal) { signal.throwIfAborted(); calls.push({ kind: 'probe', name, config }); return { status: 'connected', toolCount: 2 } },
    async oauth(name, config, onUrl, signal) { signal.throwIfAborted(); calls.push({ kind: 'oauth', name, config }); onUrl('https://accounts.example/authorize?state=fixture') },
    async disconnect(name, config) { calls.push({ kind: 'disconnect', name, config }) },
    loadOptions: id => options[id] ?? {},
    saveOptions(id, values, schema) { expect(schema.apiKey?.sensitive).toBe(true); options[id] = values as Record<string, string> },
    deleteOptions(id) { delete options[id]; calls.push({ kind: 'delete', name: id }) },
    clearOAuth(name, config) { calls.push({ kind: 'clearOAuth', name, config }) },
  }
  return { dependencies, calls, options }
}
const signal = () => new AbortController().signal

describe('remote connector plugin integration', () => {
  test('query credentials stay in sensitive storage and existing loader resolves the same encoded endpoint', async () => {
    const r = recipe({ type: 'api-key', in: 'query', name: 'key' })
    const f = fixture()
    const plugin = buildRemotePlugin(r)
    saveRemoteApiKey(r, 'secret&other=value#fragment', f.dependencies)
    expect(JSON.stringify(plugin)).not.toContain('secret')
    expect(plugin.manifest.userConfig?.apiKey?.sensitive).toBe(true)
    const resolved = resolvePluginMcpEnvironment(plugin.mcpConfig.mcpServers.service, { path: '/tmp/owned-plugin', source: r.pluginId }, f.options[r.pluginId])
    expect('url' in resolved && resolved.url).toBe('https://official.example/mcp?format=0&key=secret%26other%3Dvalue%23fragment')
    const scoped = addPluginScopeToServers({ service: resolved }, 'office-maps-fixture', r.pluginId)
    const bridge = createRemoteConnectorBridge(r, f.dependencies)
    expect(await bridge.check(signal())).toEqual({ authenticated: true, verification: 'remote', toolCount: 2 })
    expect(f.calls[0]?.config).toEqual(scoped[bridge.serverName])
  })
  test('header credentials preserve Bearer prefix without writing API keys into plugin files', async () => {
    const r = recipe({ type: 'api-key', in: 'header', name: 'Authorization', prefix: 'Bearer ' })
    const f = fixture()
    const bridge = createRemoteConnectorBridge(r, f.dependencies)
    expect(bridge.isConfigured()).toBe(false)
    await expect(bridge.check(signal())).rejects.toThrow('Configure')
    saveRemoteApiKey(r, 'fake-pat', f.dependencies)
    await bridge.check(signal())
    expect(f.calls[0]?.config).toMatchObject({ headers: { Authorization: 'Bearer fake-pat' }, scope: 'dynamic', pluginSource: r.pluginId })
    expect(JSON.stringify(buildRemotePlugin(r))).not.toContain('fake-pat')
    for (const key of ['bad\nheader', 'bad\rheader', '${USER_SECRET}', '']) expect(() => saveRemoteApiKey(r, key, f.dependencies)).toThrow()
  })
  test('OAuth uses the plugin loader identity and only cleans its own slots', async () => {
    const r = recipe({ type: 'oauth', clientId: 'public-client' })
    const f = fixture()
    const bridge = createRemoteConnectorBridge(r, f.dependencies)
    const urls: string[] = []
    await bridge.authenticate(signal(), (_phase, url) => { if (url) urls.push(url) })
    expect(urls).toEqual(['https://accounts.example/authorize?state=fixture'])
    expect(f.calls[0]).toMatchObject({ kind: 'oauth', name: 'plugin:office-maps-fixture:service', config: { oauth: { clientId: 'public-client' } } })
    await bridge.removeCredentials()
    expect(f.calls.some(call => call.kind === 'clearOAuth' && call.name === bridge.serverName)).toBe(true)
    expect(f.options['another-plugin@other']).toEqual({ apiKey: 'keep-other-secret' })
  })
  test('discovery must return tools; missing auth, cancellation and failures never report ready or raw secrets', async () => {
    const f = fixture()
    const bridge = createRemoteConnectorBridge(recipe({ type: 'none' }), f.dependencies)
    f.dependencies.probe = async () => ({ status: 'needs-auth', toolCount: 0 })
    expect((await bridge.check(signal())).authenticated).toBe(false)
    f.dependencies.probe = async () => ({ status: 'connected', toolCount: 0 })
    await expect(bridge.check(signal())).rejects.toThrow('Unable to connect')
    f.dependencies.probe = async () => { throw new Error('https://host/?key=do-not-expose') }
    try { await bridge.check(signal()) } catch (error) { expect(String(error)).not.toContain('do-not-expose') }
    const controller = new AbortController()
    controller.abort()
    await expect(bridge.check(controller.signal)).rejects.toThrow()
  })
  test('foreign identities and injected endpoint/header fields are rejected before mutation', () => {
    expect(() => buildRemotePlugin({ ...recipe({ type: 'none' }), pluginId: 'user-owned@other' })).toThrow('identity')
    expect(() => buildRemotePlugin({ ...recipe({ type: 'none' }), endpoint: 'http://example.com/mcp' })).toThrow('HTTPS')
    expect(() => buildRemotePlugin(recipe({ type: 'api-key', in: 'header', name: 'X-Key\r\nInjected' }))).toThrow()
  })
})

test('each explicit remote check clears only its own cached connection before fresh discovery', async () => {
  const f = fixture()
  const bridge = createRemoteConnectorBridge(recipe({ type: 'none' }), f.dependencies)
  await bridge.check(signal())
  await bridge.check(signal())
  expect(f.calls.map(call => call.kind)).toEqual(['disconnect', 'probe', 'disconnect', 'probe'])
  expect(f.calls.every(call => call.name === bridge.serverName)).toBe(true)
  f.dependencies.probe = async () => ({ status: 'needs-auth', toolCount: 0 })
  expect((await bridge.check(signal())).authenticated).toBe(false)
  const count = f.calls.length
  const aborted = new AbortController()
  aborted.abort()
  await expect(bridge.check(aborted.signal)).rejects.toThrow()
  expect(f.calls).toHaveLength(count)
})
