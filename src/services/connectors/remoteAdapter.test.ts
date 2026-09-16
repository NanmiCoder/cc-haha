import { expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectorDefinition } from './types.js'
import type { RemoteConnectorRecipe } from './remoteConnector.js'
import { createRemoteConnectorAdapter, type RemoteAdapterDependencies } from './remoteAdapter.js'

const definition: ConnectorDefinition = { id: 'remote-fixture', pluginId: 'office-remote-fixture@haha-connectors', version: '1.0.0', packageName: 'remote-fixture', homepage: 'https://official.example', credentialMode: 'isolated', platforms: ['darwin-arm64'], transport: 'mcp' }
const recipe: RemoteConnectorRecipe = { id: definition.id, pluginId: definition.pluginId, version: definition.version, endpoint: 'https://official.example/mcp', transport: 'http', auth: { type: 'api-key', in: 'query', name: 'key' } }
function fixture() {
  let configured = false
  const calls: string[] = []
  const dependencies: RemoteAdapterDependencies = {
    createBridge: () => ({
      serverName: 'plugin:office-remote-fixture:service', isConfigured: () => configured,
      async check(signal) { signal.throwIfAborted(); calls.push('discover'); return { authenticated: true, verification: 'remote', toolCount: 3 } },
      async authenticate(signal) { signal.throwIfAborted(); calls.push('authenticate') },
      async deactivate() { calls.push('deactivate') },
      async removeCredentials() { calls.push('remove-credentials'); configured = false },
    }),
    saveApiKey(_recipe, key) { configured = Boolean(key); calls.push(`save:${key}`) },
  }
  return { dependencies, calls }
}
const signal = () => new AbortController().signal

test('remote adapter prepares marker and handles missing key, replacement, discovery and retained empty fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote adapter 空格 '))
  const f = fixture()
  try {
    const adapter = createRemoteConnectorAdapter(definition, root, recipe, f.dependencies)
    const installed = await adapter.prepare(signal(), () => {})
    expect(installed).toEqual({ directory: join(root, 'remote', definition.id, definition.version), command: '', args: [], env: {} })
    expect((await adapter.check(installed, signal())).authenticated).toBe(false)
    await expect(adapter.authenticate(installed, signal(), () => {})).rejects.toThrow('API key')
    expect(f.calls).toEqual([])
    await adapter.configure!({ apiKey: 'fixture-secret' })
    expect(f.calls).toEqual(['deactivate', 'save:fixture-secret'])
    await adapter.configure!({ apiKey: '  ' })
    expect(f.calls).toHaveLength(2)
    expect((await adapter.check(installed, signal())).authenticated).toBe(true)
    await adapter.deactivate()
    expect(f.calls).not.toContain('remove-credentials')
    await mkdir(join(root, 'remote', 'another'), { recursive: true })
    await writeFile(join(root, 'remote', 'another', 'keep'), 'keep')
    await adapter.remove(installed)
    await expect(access(installed.directory)).rejects.toThrow()
    expect(await readFile(join(root, 'remote', 'another', 'keep'), 'utf8')).toBe('keep')
    expect(f.calls).toContain('remove-credentials')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('remote adapter validates owned paths and configuration before side effects', async () => {
  const f = fixture()
  const adapter = createRemoteConnectorAdapter(definition, '/tmp/owned-remote-fixture', recipe, f.dependencies)
  await expect(adapter.remove({ directory: '/tmp/unrelated', command: '', args: [], env: {} })).rejects.toThrow('installation')
  await expect(adapter.configure!({ endpoint: 'https://evil.example' })).rejects.toThrow('configuration')
  await expect(adapter.configure!({ apiKey: 'key\r\ninjected' })).rejects.toThrow('valid')
  const controller = new AbortController()
  controller.abort()
  await expect(adapter.prepare(controller.signal, () => {})).rejects.toThrow()
  expect(f.calls).toEqual([])
  expect(() => createRemoteConnectorAdapter({ ...definition, version: '../../user-data' }, '/tmp/root', { ...recipe, version: '../../user-data' }, f.dependencies)).toThrow('definition')
})

test('OAuth and anonymous recipes need no local key and use the same check/auth lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote oauth fixture '))
  try {
    for (const auth of [{ type: 'oauth' }, { type: 'none' }] as const) {
      const f = fixture()
      const createBridge = f.dependencies.createBridge
      f.dependencies.createBridge = (...args) => ({ ...createBridge(...args), isConfigured: () => true })
      const adapter = createRemoteConnectorAdapter(definition, root, { ...recipe, auth }, f.dependencies)
      const installed = await adapter.prepare(signal(), () => {})
      await adapter.authenticate(installed, signal(), () => {})
      expect((await adapter.check(installed, signal())).authenticated).toBe(true)
      expect(f.calls).toEqual(['authenticate', 'discover'])
      await expect(adapter.configure!({ apiKey: 'unexpected' })).rejects.toThrow('does not use')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
