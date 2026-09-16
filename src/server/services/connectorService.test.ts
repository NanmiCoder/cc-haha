import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorService, type ConnectorServiceDependencies } from './connectorService.js'
import type { ConnectorAdapter } from '../../services/connectors/types.js'

const definition = { id: 'feishu' as const, pluginId: 'feishu@test', packageName: 'fake', version: '1.0.0', homepage: 'https://example.test', credentialMode: 'shared' as const, platforms: [`${process.platform}-${process.arch}`] }
async function settled(service: ConnectorService) {
  for (let index = 0; index < 100 && service.get('feishu').operation; index++) await new Promise(resolve => setTimeout(resolve, 1))
  expect(service.get('feishu').operation).toBeUndefined()
}
function fixture(overrides: Partial<ConnectorAdapter> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'connector-service-'))
  let authenticated = false
  const calls: string[] = []
  const adapter: ConnectorAdapter = {
    prepare: async () => ({ directory: root, command: 'fake', args: [], env: {} }),
    authenticate: async () => { calls.push('authenticate'); authenticated = true }, check: async () => ({ authenticated, verification: 'remote' }),
    deactivate: async () => { calls.push('deactivate') }, remove: async () => { calls.push('remove') }, ...overrides,
  }
  const deps: ConnectorServiceDependencies = { root, definitions: [definition], createAdapter: () => adapter,
    bridge: { installConnectorPlugin: async () => { calls.push('install') }, setConnectorPluginEnabled: async (_, enabled) => { calls.push(`enabled:${enabled}`) },
      removeConnectorPlugin: async () => { calls.push('remove-plugin') }, isConnectorPluginReady: async () => true, reloadConnectorSessions: async () => { calls.push('reload') } } }
  return { service: new ConnectorService(deps), deps, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('remote authorization verifies chat tools before publishing ready and fails closed on refresh failure', async () => {
  const f = fixture()
  try {
    f.deps.definitions = [{ ...definition, transport: 'mcp' }]
    f.service.action('feishu', 'prepare')
    await settled(f.service)
    const refreshes: Array<[string | undefined, unknown]> = []
    let ready = true
    f.deps.bridge.reloadConnectorSessions = async (sessionId, requiredServer) => {
      refreshes.push([sessionId, requiredServer])
      if (requiredServer && !ready) throw new Error('Chat still needs auth')
    }
    f.service.action('feishu', 'authenticate', { sessionId: 'active-chat', acknowledgeSharedCredentials: true })
    await settled(f.service)
    expect(refreshes).toEqual([['active-chat', undefined], ['active-chat', { ...definition, transport: 'mcp' }]])
    expect(f.service.get('feishu')).toMatchObject({ status: 'ready', runtime: 'ready' })
    ready = false
    f.service.action('feishu', 'check', { sessionId: 'active-chat' })
    await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ status: 'error', runtime: 'error', enabled: false, failedPhase: 'refreshing-sessions' })
    expect(refreshes.at(-1)).toEqual(['active-chat', undefined])
  } finally { f.cleanup() }
})
test('installation, shared authorization and runtime readiness remain independent; restart invalidates readiness', async () => {
  const f = fixture()
  try {
    f.service.action('feishu', 'prepare')
    await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ installed: true, enabled: false, status: 'needs-auth', runtime: 'missing' })
    expect(() => f.service.action('feishu', 'check')).toThrow('Confirm shared')
    expect(() => f.service.action('feishu', 'authenticate')).toThrow('Confirm shared')
    f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true })
    await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ connection: 'connected', enabled: true, runtime: 'ready' })
    expect(f.calls.filter(call => call === 'authenticate')).toHaveLength(1)
    expect(new ConnectorService(f.deps).get('feishu').runtime).toBe('missing')
    f.service.action('feishu', 'remove')
    await settled(f.service)
    expect(f.calls.indexOf('remove-plugin')).toBeLessThan(f.calls.indexOf('remove'))
    expect(f.service.get('feishu')).toMatchObject({ installed: false, enabled: false })
  } finally { f.cleanup() }
})
test('cancel retains operation lock until aborted adapter exits and returns a neutral needs-auth state', async () => {
  let release: () => void = () => {}
  const f = fixture({ authenticate: async () => new Promise<void>(resolve => { release = resolve }) })
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true })
    await new Promise(resolve => setTimeout(resolve, 1))
    f.service.action('feishu', 'cancel')
    expect(f.service.get('feishu').operation?.phase).toBe('cancelling')
    expect(() => f.service.action('feishu', 'check')).toThrow('already running')
    release(); await settled(f.service)
    // Cancellation is not a runtime failure: the connector asks to be
    // connected again instead of offering a retry check, and stored
    // credentials are detached rather than deleted.
    expect(f.service.get('feishu')).toMatchObject({ enabled: false, runtime: 'missing', status: 'needs-auth', connection: 'needs-auth' })
    expect(f.service.get('feishu').error).toBeUndefined()
    expect(f.service.get('feishu').failedPhase).toBeUndefined()
    expect(f.calls).not.toContain('enabled:true')
    expect(f.calls).not.toContain('remove')
  } finally { f.cleanup() }
})

test('cancelling an upgrade restores the previous ready connection instead of an error', async () => {
  const f = fixture()
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true }); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ status: 'ready', enabled: true, installedVersion: '1.0.0' })
    f.deps.definitions = [{ ...definition, version: '2.0.0' }]
    let release: () => void = () => {}
    const baseAdapter = f.deps.createAdapter
    f.deps.createAdapter = (def, root) => ({ ...baseAdapter(def, root), prepare: async () => { await new Promise<void>(resolve => { release = resolve }); return { directory: root, command: 'fake', args: [], env: {} } } })
    f.service.action('feishu', 'prepare')
    await new Promise(resolve => setTimeout(resolve, 1))
    f.service.action('feishu', 'cancel')
    release(); await settled(f.service)
    // The old installation was rolled back and re-enabled, so the connector is
    // ready again rather than reported as a failed update.
    expect(f.service.get('feishu')).toMatchObject({ installedVersion: '1.0.0', updateAvailable: true, status: 'ready', runtime: 'ready', enabled: true, connection: 'connected' })
    expect(f.service.get('feishu').error).toBeUndefined()
    expect(f.service.get('feishu').failedPhase).toBeUndefined()
  } finally { f.cleanup() }
})

test('cancelling a first install leaves no installed or failed connector behind', async () => {
  let release: () => void = () => {}
  const f = fixture({ prepare: async () => { await new Promise<void>(resolve => { release = resolve }); return { directory: '', command: '', args: [], env: {} } } })
  try {
    f.service.action('feishu', 'prepare')
    await new Promise(resolve => setTimeout(resolve, 1))
    f.service.action('feishu', 'cancel')
    release(); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ installed: false, status: 'not-installed', enabled: false, connection: 'disconnected', runtime: 'missing' })
    expect(f.service.get('feishu').error).toBeUndefined()
    expect(f.service.get('feishu').failedPhase).toBeUndefined()
    expect(f.calls).not.toContain('install')
    expect(f.calls).not.toContain('enabled:true')
  } finally { f.cleanup() }
})

test('a cancelled upgrade whose rollback fails keeps the failure visible', async () => {
  const f = fixture()
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true }); await settled(f.service)
    f.deps.definitions = [{ ...definition, version: '2.0.0' }]
    let release: () => void = () => {}
    const baseAdapter = f.deps.createAdapter
    f.deps.createAdapter = (def, root) => ({ ...baseAdapter(def, root), prepare: async () => { await new Promise<void>(resolve => { release = resolve }); return { directory: root, command: 'fake', args: [], env: {} } } })
    f.deps.bridge.installConnectorPlugin = async () => { throw new Error('simulated rollback failure') }
    f.service.action('feishu', 'prepare')
    await new Promise(resolve => setTimeout(resolve, 1))
    f.service.action('feishu', 'cancel')
    release(); await settled(f.service)
    // A rollback that could not restore the old installation must not be
    // reported as a neutral cancellation.
    expect(f.service.get('feishu')).toMatchObject({ enabled: false, runtime: 'error', status: 'error' })
    expect(f.service.get('feishu').error).toContain('cancelled')
    expect(f.service.get('feishu').failedPhase).toBeDefined()
  } finally { f.cleanup() }
})
test('GET is read-only and negative checks cannot enable the plugin', async () => {
  const f = fixture()
  try {
    expect(f.service.list()[0]?.status).toBe('not-installed')
    expect(f.calls).toEqual([])
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.calls.length = 0
    f.service.action('feishu', 'check', { acknowledgeSharedCredentials: true }); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ installed: true, connection: 'needs-auth', enabled: false, runtime: 'missing' })
    expect(f.calls).not.toContain('enabled:true')
  } finally { f.cleanup() }
})
test('runtime failure disables the plugin and does not expose secret-bearing adapter errors', async () => {
  const f = fixture({ check: async () => { throw new Error('secret-token-do-not-expose') } })
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'check', { acknowledgeSharedCredentials: true }); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ enabled: false, runtime: 'error', status: 'error' })
    expect(JSON.stringify(f.service.get('feishu'))).not.toContain('secret-token')
    expect(f.calls.at(-2)).toBe('enabled:false')
  } finally { f.cleanup() }
})
test('local credential presence is configured, not remotely verified readiness', async () => {
  const f = fixture({ check: async () => ({ authenticated: true, verification: 'local' }) })
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'check', { acknowledgeSharedCredentials: true }); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ enabled: true, runtime: 'ready', status: 'configured', verification: 'local' })
    expect(new ConnectorService(f.deps).get('feishu').verification).toBeUndefined()
  } finally { f.cleanup() }
})
test('a confirmed shared connection can be re-enabled after deactivation without another login', async () => {
  const f = fixture()
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true }); await settled(f.service)
    f.service.action('feishu', 'deactivate'); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ installed: true, enabled: false, status: 'disabled' })
    f.service.action('feishu', 'check'); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ enabled: true, status: 'ready', verification: 'remote' })
  } finally { f.cleanup() }
})
test('background persistence failure is contained and cannot leave ready or a stuck operation', async () => {
  const f = fixture()
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    const adapter = f.deps.createAdapter(definition, f.deps.root)
    adapter.authenticate = async () => { mkdirSync(join(f.deps.root, 'state.json.tmp')) }
    f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true })
    await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ status: 'error', runtime: 'error', enabled: false, failedPhase: 'persistence' })
    rmSync(join(f.deps.root, 'state.json.tmp'), { recursive: true })
    f.service.action('feishu', 'check', { acknowledgeSharedCredentials: true })
    await settled(f.service)
    expect(f.service.get('feishu').status).toBe('needs-auth')
  } finally { f.cleanup() }
})
test('confirmed binding reuses an existing shared account without running login or init', async () => {
  const f = fixture({ check: async () => ({ authenticated: true, verification: 'remote', accountLabel: 'Existing account' }) })
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true }); await settled(f.service)
    expect(f.calls).not.toContain('authenticate')
    expect(f.service.get('feishu')).toMatchObject({ enabled: true, status: 'ready', accountLabel: 'Existing account' })
  } finally { f.cleanup() }
})
test('a status command failure does not trigger account login', async () => {
  const f = fixture({ check: async () => { throw new Error('runtime check failed') } })
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true }); await settled(f.service)
    expect(f.calls).not.toContain('authenticate')
    expect(f.service.get('feishu')).toMatchObject({ enabled: false, status: 'error', failedPhase: 'checking' })
  } finally { f.cleanup() }
})
test('catalog upgrades retain the old installation on failure and commit the new version only after success', async () => {
  const f = fixture()
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true }); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ version: '1.0.0', installedVersion: '1.0.0', updateAvailable: false })
    f.deps.definitions = [{ ...definition, version: '2.0.0' }]
    const adapterVersions: string[] = []
    const bridgeVersions: string[] = []
    const baseAdapter = f.deps.createAdapter
    f.deps.createAdapter = (def, root) => {
      adapterVersions.push(def.version)
      return { ...baseAdapter(def, root), prepare: async () => ({ directory: join(root, 'v2'), command: 'new-binary', args: [], env: {} }) }
    }
    let failUpgrade = true
    f.deps.bridge.installConnectorPlugin = async def => {
      bridgeVersions.push(def.version)
      if (failUpgrade && def.version === '2.0.0') throw new Error('simulated bridge failure')
    }
    expect(f.service.get('feishu')).toMatchObject({ version: '2.0.0', installedVersion: '1.0.0', updateAvailable: true })
    f.service.action('feishu', 'prepare'); await settled(f.service)
    expect(bridgeVersions).toEqual(['2.0.0', '1.0.0'])
    expect(f.service.get('feishu')).toMatchObject({ installedVersion: '1.0.0', updateAvailable: true, status: 'error', enabled: true })
    f.service.action('feishu', 'check'); await settled(f.service)
    expect(adapterVersions.at(-1)).toBe('1.0.0')
    expect(f.service.get('feishu').status).toBe('ready')
    failUpgrade = false
    f.service.action('feishu', 'prepare'); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ version: '2.0.0', installedVersion: '2.0.0', updateAvailable: false, status: 'needs-auth', enabled: false })
    f.service.action('feishu', 'check'); await settled(f.service)
    expect(adapterVersions.at(-1)).toBe('2.0.0')
  } finally { f.cleanup() }
})
test('legacy missing installed version advertises an update; invalid stored versions cannot select runtime paths', async () => {
  const f = fixture()
  try {
    const record = { installed: true, enabled: false, sharedCredentialsAcknowledged: true, installation: {
      directory: join(f.deps.root, 'runtime', 'feishu', `0.9.0-${process.platform}-${process.arch}`), command: 'legacy', args: [], env: {},
    } }
    writeFileSync(join(f.deps.root, 'state.json'), JSON.stringify({ schemaVersion: 1, connectors: { feishu: record } }))
    const legacy = new ConnectorService(f.deps)
    expect(legacy.get('feishu')).toMatchObject({ installed: true, updateAvailable: true })
    expect(legacy.get('feishu').installedVersion).toBeUndefined()
    const baseAdapter = f.deps.createAdapter
    const versions: string[] = []
    f.deps.createAdapter = (def, root) => { versions.push(def.version); return baseAdapter(def, root) }
    legacy.action('feishu', 'check'); await settled(legacy)
    expect(versions).toEqual(['0.9.0'])
    writeFileSync(join(f.deps.root, 'state.json'), JSON.stringify({ schemaVersion: 1, connectors: { feishu: { ...record, installedVersion: '../../outside' } } }))
    const invalid = new ConnectorService(f.deps)
    invalid.action('feishu', 'check'); await settled(invalid)
    expect(versions).toEqual(['0.9.0'])
    expect(invalid.get('feishu').status).toBe('error')
  } finally { f.cleanup() }
})


test('remote secrets reach configure only; configuration failure detaches sessions and never leaks into DTO or state', async () => {
  const secret = 'fake-private-api-key'
  let rejectConfiguration = false
  const configs: Record<string, string>[] = []
  const f = fixture({
    check: async () => ({ authenticated: true, verification: 'remote' }),
    configure: async config => {
      configs.push(config)
      expect(f.calls.slice(-2)).toEqual(['enabled:false', 'reload'])
      expect(f.service.get('feishu')).toMatchObject({ enabled: false, runtime: 'missing' })
      if (rejectConfiguration) throw new Error(secret)
    },
  })
  f.deps.definitions = [{ ...definition, credentialMode: 'isolated' }]
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'authenticate', { configuration: { apiKey: secret } }); await settled(f.service)
    expect(configs).toEqual([{ apiKey: secret }])
    expect(f.service.get('feishu').status).toBe('ready')
    rejectConfiguration = true
    f.service.action('feishu', 'authenticate', { configuration: { apiKey: secret } }); await settled(f.service)
    expect(f.service.get('feishu')).toMatchObject({ status: 'error', enabled: false, runtime: 'error' })
    expect(f.service.get('feishu').verification).toBeUndefined()
    expect(JSON.stringify(f.service.list())).not.toContain(secret)
    expect(readFileSync(join(f.deps.root, 'state.json'), 'utf8')).not.toContain(secret)
  } finally { f.cleanup() }
})
test('negative recheck reloads disabled plugin before consulting remote account', async () => {
  let authenticated = true
  const f = fixture({ check: async () => {
    expect(f.calls.slice(-2)).toEqual(['enabled:false', 'reload'])
    return { authenticated, verification: 'remote' }
  } })
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.service.action('feishu', 'check', { acknowledgeSharedCredentials: true }); await settled(f.service)
    authenticated = false
    f.calls.length = 0
    f.service.action('feishu', 'check'); await settled(f.service)
    expect(f.calls).toEqual(['enabled:false', 'reload'])
    expect(f.service.get('feishu')).toMatchObject({ status: 'needs-auth', enabled: false })
  } finally { f.cleanup() }
})
test('installed upgrades cannot replace credentials before a rollback, and check never accepts configuration', async () => {
  const f = fixture()
  try {
    f.service.action('feishu', 'prepare'); await settled(f.service)
    f.deps.definitions = [{ ...definition, version: '2.0.0' }]
    expect(() => f.service.action('feishu', 'prepare', { configuration: { apiKey: 'new-secret' } })).toThrow('Use authentication')
    expect(() => f.service.action('feishu', 'check', { acknowledgeSharedCredentials: true, configuration: {} })).toThrow('Configuration is only')
    expect(f.service.get('feishu').installedVersion).toBe('1.0.0')
  } finally { f.cleanup() }
})
test('one remote operation does not block or change another connector state', async () => {
  let release: () => void = () => {}
  const f = fixture({ prepare: async () => {
    await new Promise<void>(resolve => { release = resolve })
    return { directory: f.deps.root, command: '', args: [], env: {} }
  } })
  f.deps.definitions = [{ ...definition, credentialMode: 'isolated' }, { ...definition, id: 'other', credentialMode: 'isolated' }]
  try {
    f.service.action('feishu', 'prepare')
    expect(f.service.get('other')).toMatchObject({ installed: false, status: 'not-installed' })
    expect(f.service.get('other').operation).toBeUndefined()
    f.service.action('other', 'deactivate')
    for (let i = 0; i < 100 && f.service.get('other').operation; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(f.service.get('other').status).toBe('disabled')
    expect(f.service.get('feishu').operation).toBeDefined()
    release(); await settled(f.service)
    expect(f.service.get('feishu').installed).toBe(true)
    expect(f.service.get('other').installed).toBe(false)
  } finally { release(); f.cleanup() }
})

test('skill bundles load on add without account authentication and recover through check after restart', async () => {
  const f = fixture({ check: async () => ({ authenticated: true, verification: 'local' }) })
  try {
    f.deps.definitions = [{ ...definition, credentialMode: 'isolated', collection: 'tools', transport: 'skills' }]
    const service = new ConnectorService(f.deps)
    service.action('feishu', 'prepare')
    await settled(service)
    expect(service.get('feishu')).toMatchObject({ installed: true, status: 'configured', enabled: true, verification: 'local' })
    expect(f.calls).not.toContain('authenticate')
    const restarted = new ConnectorService(f.deps)
    expect(restarted.get('feishu').runtime).toBe('missing')
    restarted.action('feishu', 'check')
    await settled(restarted)
    expect(restarted.get('feishu')).toMatchObject({ status: 'configured', runtime: 'ready' })
    restarted.action('feishu', 'remove')
    await settled(restarted)
    expect(restarted.get('feishu').installed).toBe(false)
  } finally { f.cleanup() }
})

test('a negative skill package validation cannot enable or report loaded', async () => {
  const f = fixture({ check: async () => ({ authenticated: false, verification: 'local' }) })
  try {
    f.deps.definitions = [{ ...definition, credentialMode: 'isolated', transport: 'skills', collection: 'tools' }]
    const service = new ConnectorService(f.deps)
    service.action('feishu', 'prepare')
    await settled(service)
    expect(service.get('feishu')).toMatchObject({ status: 'error', enabled: false })
    expect(f.calls).not.toContain('enabled:true')
  } finally { f.cleanup() }
})

for (const failure of ['reload', 'deactivate'] as const) {
  test(`cancelled authentication preserves ${failure} cleanup failures`, async () => {
    let release: () => void = () => {}
    const f = fixture({ authenticate: async () => new Promise<void>(resolve => { release = resolve }),
      ...(failure === 'deactivate' ? { deactivate: async () => { throw new Error('cleanup failed') } } : {}) })
    try {
      f.service.action('feishu', 'prepare'); await settled(f.service)
      f.service.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true })
      await new Promise(resolve => setTimeout(resolve, 1))
      if (failure === 'reload') f.deps.bridge.reloadConnectorSessions = async () => { throw new Error('cleanup failed') }
      f.service.action('feishu', 'cancel')
      release(); await settled(f.service)
      expect(f.service.get('feishu')).toMatchObject({ status: 'error', runtime: 'error', enabled: false })
      expect(f.service.get('feishu').failedPhase).toBeDefined()
    } finally { f.cleanup() }
  })
}
