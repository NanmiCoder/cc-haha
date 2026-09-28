// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { createDefaultNetworkProfiles } from '../../../src/features/network-manager/networkTypes'
import { proxyBypassCovers } from '../../../src/features/network-manager/networkTypes'
import { createProxyAdapter, hash, type ProxyUndo } from './proxy'
import type { NetworkCommand } from './powershell'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture(patch: Record<string, unknown> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-network-proxy-test-'))
  directories.push(directory)
  const filePath = path.join(directory, 'proxy.yaml')
  const original = {
    'external-controller': '127.0.0.1:19090',
    secret: 'CONTROLLER_SECRET_FIXTURE_ONLY',
    'mixed-port': 7897,
    mode: 'global',
    tun: { enable: true, stack: 'mixed', 'auto-route': true },
    dns: { enable: true, nameserver: ['192.0.2.53'] },
    proxies: [{ name: 'Fixture', type: 'http', server: '192.0.2.1', port: 8080, password: 'PROXY_PASSWORD_FIXTURE_ONLY' }],
    'proxy-groups': [{ name: 'Global', type: 'select', proxies: ['Fixture', 'DIRECT'] }],
    rules: ['DOMAIN,example.test,Global', 'IP-CIDR,191.168.0.0/16,DIRECT', 'MATCH,Global'],
    ...patch,
  }
  const text = stringify(original)
  await fs.writeFile(filePath, text)
  const profile = { ...createDefaultNetworkProfiles()[0], proxyConfigPath: filePath }
  let runtime: Record<string, any> = structuredClone(original)
  let failReloads = 0
  const request = vi.fn(async (_base: string, _secret: string, route: string, body?: unknown): Promise<any> => {
    if (route === '/version') return { version: 'fixture' }
    if (route === '/configs') return structuredClone(runtime)
    if (route === '/rules') return { rules: (runtime.rules ?? []).map((rule: string) => {
      const [type, payload, proxy] = rule.split(',')
      return { type, payload, proxy }
    }) }
    if (route === '/configs?force=true') {
      expect(body).toEqual({ path: filePath })
      if (failReloads > 0) {
        failReloads--
        throw new Error('PROXY_CONTROLLER_UNAVAILABLE')
      }
      runtime = parse(await fs.readFile(filePath, 'utf8'))
      return {}
    }
    throw new Error('Unexpected controller operation')
  })
  const runner = vi.fn(async (command: NetworkCommand) => {
    if (command.action === 'proxyController') {
      expect(command.configPath).toBe(filePath)
      return null
    }
    expect(command.action).toBe('copyAcl')
    expect(command.source).toBe(filePath)
    const target = String(command.target)
    expect(path.dirname(target)).toBe(directory)
    expect(path.basename(target)).toMatch(/^proxy\.yaml\.[a-f0-9-]+\.tmp$/)
    // The replacement must inherit the existing ACL before it contains any secrets.
    expect((await fs.stat(target)).size).toBe(0)
    return null
  })
  return {
    filePath, profile, original, text, request, runner,
    adapter: createProxyAdapter(request, runner),
    read: async () => parse(await fs.readFile(filePath, 'utf8')),
    runtime: () => runtime,
    changeRuntime: (values: Record<string, unknown>) => Object.assign(runtime, values),
    failReload: () => { failReloads++ },
    reloads: () => request.mock.calls.filter(call => call[2] === '/configs?force=true'),
  }
}

describe('network proxy controlled hot reload', () => {
  it('rejects a controller port owned by another process before contacting it', async () => {
    if (process.platform !== 'win32') return
    const f = await fixture()
    const runner = vi.fn(async () => ({ controller: '127.0.0.1:39798', instanceId: '102:fixture-start', listeningPorts: [7897, 39797] }))
    const adapter = createProxyAdapter(f.request, runner)
    await expect(adapter.inspect(f.profile)).rejects.toThrow('PROXY_CONTROLLER_OWNER_MISMATCH')
    expect(f.request).not.toHaveBeenCalled()
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(f.text)
  })

  it('includes verified process identity in a snapshot without exposing credentials', async () => {
    if (process.platform !== 'win32') return
    const f = await fixture()
    const runner = vi.fn(async (command: NetworkCommand) => {
      expect(command).toEqual({ action: 'proxyController', configPath: f.filePath, proxyPort: 7897 })
      return { controller: '127.0.0.1:39798', instanceId: '102:fixture-start', listeningPorts: [7897, 39798] }
    })
    const result = await createProxyAdapter(f.request, runner).inspect(f.profile)
    expect(result.instanceId).toBe('102:fixture-start')
    expect(JSON.stringify(result)).not.toMatch(/CONTROLLER_SECRET_FIXTURE_ONLY|PROXY_PASSWORD_FIXTURE_ONLY/)
  })

  it('uses the running SakuraCat controller override for the exact YAML path', async () => {
    const f = await fixture()
    const runner = async (command: NetworkCommand) => command.action === 'proxyController'
      ? { controller: '127.0.0.1:39798' }
      : f.runner(command)
    const adapter = createProxyAdapter(f.request, runner)
    const observation = await adapter.inspect(f.profile)
    expect(observation.controller).toBe('http://127.0.0.1:39798')
    expect(f.request.mock.calls.every(call => call[0] === 'http://127.0.0.1:39798')).toBe(true)
    const undo = await adapter.apply(f.profile, observation.configHash)
    expect(await adapter.rollback(f.profile, undo)).toBe(true)
    expect(f.request.mock.calls.every(call => call[0] === 'http://127.0.0.1:39798')).toBe(true)
  })

  it('accepts an existing 10/8 DIRECT rule for the container subnet without adding a duplicate', async () => {
    const f = await fixture({ rules: [
      'DOMAIN,example.test,DIRECT',
      'IP-CIDR,191.168.0.0/16,DIRECT',
      'IP-CIDR,10.0.0.0/8,DIRECT',
      'MATCH,Global',
    ] })
    const observation = await f.adapter.inspect(f.profile)
    expect(proxyBypassCovers(observation.bypassPrefixes, f.profile.containerPrefix)).toBe(true)
    await f.adapter.apply(f.profile, observation.configHash)
    const applied = await f.read()
    expect(applied.rules).toEqual(f.original.rules)
    expect(applied.mode).toBe('rule')
  })

  it('does not count broad 10/8 DIRECT behind a prior container proxy rule', async () => {
    const f = await fixture({ rules: [
      'IP-CIDR,10.204.19.0/24,Global',
      'IP-CIDR,10.0.0.0/8,DIRECT',
      'MATCH,Global',
    ] })
    const observation = await f.adapter.inspect(f.profile)
    expect(proxyBypassCovers(observation.bypassPrefixes, f.profile.containerPrefix)).toBe(false)
  })

  it('ignores inert disabled TUN spelling and absent versus zero routing mark', async () => {
    const f = await fixture({ tun: { enable: false, stack: 'gvisor' } })
    f.changeRuntime({ tun: { enable: false, stack: 'gVisor' }, 'routing-mark': 0 })
    await expect(f.adapter.inspect(f.profile)).resolves.toMatchObject({ available: true })
  })

  it('preserves secrets, TUN, DNS and unrelated rule order while recording the inverse before mutation', async () => {
    const f = await fixture()
    const observation = await f.adapter.inspect(f.profile)
    expect(JSON.stringify(observation)).not.toContain('FIXTURE_ONLY')
    let prepared: ProxyUndo | undefined
    const undo = await f.adapter.apply(f.profile, observation.configHash, async inverse => {
      expect(await fs.readFile(f.filePath, 'utf8')).toBe(f.text)
      expect(f.reloads()).toHaveLength(0)
      prepared = inverse
    })
    expect(undo).toEqual(prepared)
    expect(JSON.stringify(undo)).not.toContain('FIXTURE_ONLY')
    const applied = await f.read()
    expect(applied).toEqual({
      ...f.original,
      mode: 'rule',
      rules: ['IP-CIDR,10.204.19.0/24,DIRECT,no-resolve', 'DOMAIN,example.test,Global', 'IP-CIDR,191.168.0.0/16,DIRECT', 'MATCH,Global'],
    })
    expect(f.runtime().tun).toEqual(f.original.tun)
    expect(f.request.mock.calls.every(call => ['/version', '/configs', '/rules', '/configs?force=true'].includes(call[2]))).toBe(true)
    expect(f.request.mock.calls.every(call => call[0] === 'http://127.0.0.1:19090' && call[1] === 'CONTROLLER_SECRET_FIXTURE_ONLY')).toBe(true)
    expect(await f.adapter.rollback(f.profile, undo)).toBe(true)
    expect(await f.read()).toEqual(f.original)
    expect(f.runtime()).toEqual(f.original)
  })

  it('does not mutate the file or controller if durable preparation fails', async () => {
    const f = await fixture()
    await expect(f.adapter.apply(f.profile, hash(f.text), async () => { throw new Error('JOURNAL_WRITE_FAILED') })).rejects.toThrow('JOURNAL_WRITE_FAILED')
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(f.text)
    expect(f.reloads()).toHaveLength(0)
  })

  it('rechecks runtime after yielding to the durable preparation callback', async () => {
    const f = await fixture()
    await expect(f.adapter.apply(f.profile, hash(f.text), async () => {
      f.changeRuntime({ tun: { enable: false } })
    })).rejects.toThrow('PROXY_RUNTIME_CONFIG_MISMATCH')
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(f.text)
    expect(f.runtime().tun.enable).toBe(false)
    expect(f.reloads()).toHaveLength(0)
  })

  it('preserves a file changed while durable preparation was being saved', async () => {
    const f = await fixture()
    const changed = f.text + '# changed during journal persistence\n'
    await expect(f.adapter.apply(f.profile, hash(f.text), async () => {
      await fs.writeFile(f.filePath, changed)
    })).rejects.toThrow('PROXY_CONFIG_CHANGED')
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(changed)
    expect(f.reloads()).toHaveLength(0)
  })

  it.each(['192.0.2.1:19090', '0.0.0.0:19090', '127.0.0.1:19090/path', 'https://127.0.0.1:19090', '127.0.0.1:65536'])('rejects an unsafe controller before issuing a request: %s', async endpoint => {
    const f = await fixture({ 'external-controller': endpoint })
    await expect(f.adapter.inspect(f.profile)).rejects.toThrow(/PROXY_(LOOPBACK_REQUIRED|CONFIG_INVALID)/)
    expect(f.request).not.toHaveBeenCalled()
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(f.text)
  })

  it.each([
    { tun: { enable: false } },
    { tun: { enable: true, stack: 'system', 'auto-route': true } },
    { 'socks-port': 1080 },
    { 'interface-name': 'Another VPN' },
  ])('blocks runtime/file drift before applying instead of resetting the current control path: %j', async drift => {
    const f = await fixture()
    const observation = await f.adapter.inspect(f.profile)
    f.changeRuntime(drift)
    await expect(f.adapter.inspect(f.profile)).rejects.toThrow('PROXY_RUNTIME_CONFIG_MISMATCH')
    await expect(f.adapter.apply(f.profile, observation.configHash)).rejects.toThrow('PROXY_RUNTIME_CONFIG_MISMATCH')
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(f.text)
    expect(f.reloads()).toHaveLength(0)
  })

  it('rejects stale file hashes without overwriting another application', async () => {
    const f = await fixture()
    const changed = f.text + '# another application changed the file\n'
    await fs.writeFile(f.filePath, changed)
    await expect(f.adapter.apply(f.profile, hash(f.text))).rejects.toThrow('PROXY_CONFIG_CHANGED')
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(changed)
    expect(f.reloads()).toHaveLength(0)
  })

  it('returns the prepared inverse after a reload failure so the original file and runtime can be recovered', async () => {
    const f = await fixture()
    f.failReload()
    let prepared: ProxyUndo | undefined
    let failure: unknown
    try {
      await f.adapter.apply(f.profile, hash(f.text), async undo => { prepared = undo })
    } catch (error) { failure = error }
    expect(failure).toMatchObject({ message: 'PROXY_RELOAD_FAILED', undo: prepared })
    expect(prepared).toBeDefined()
    expect((await f.read()).mode).toBe('rule')
    expect(await f.adapter.rollback(f.profile, prepared!)).toBe(true)
    expect(await f.read()).toEqual(f.original)
    expect(f.runtime()).toEqual(f.original)
  })

  it('preserves third-party edits after apply and reports a rollback conflict', async () => {
    const f = await fixture()
    const undo = await f.adapter.apply(f.profile, hash(f.text))
    const changed = await fs.readFile(f.filePath, 'utf8') + '# preserve this edit\n'
    await fs.writeFile(f.filePath, changed)
    const reloadCount = f.reloads().length
    expect(await f.adapter.rollback(f.profile, undo)).toBe(false)
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(changed)
    expect(f.reloads()).toHaveLength(reloadCount)
  })

  it('preserves runtime-only TUN changes made by another application after apply', async () => {
    const f = await fixture()
    const undo = await f.adapter.apply(f.profile, hash(f.text))
    const applied = await fs.readFile(f.filePath, 'utf8')
    f.changeRuntime({ tun: { enable: false } })
    const reloadCount = f.reloads().length
    expect(await f.adapter.rollback(f.profile, undo)).toBe(false)
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(applied)
    expect(f.runtime().tun.enable).toBe(false)
    expect(f.reloads()).toHaveLength(reloadCount)
  })

  it('preserves runtime-only mode changes made by another application after a successful apply', async () => {
    const f = await fixture()
    const undo = await f.adapter.apply(f.profile, hash(f.text))
    const applied = await fs.readFile(f.filePath, 'utf8')
    f.changeRuntime({ mode: 'global' })
    const reloadCount = f.reloads().length
    expect(await f.adapter.rollback(f.profile, undo)).toBe(false)
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(applied)
    expect(f.runtime().mode).toBe('global')
    expect(f.reloads()).toHaveLength(reloadCount)
  })

  it('preserves runtime-only rule changes made by another application after a successful apply', async () => {
    const f = await fixture()
    const undo = await f.adapter.apply(f.profile, hash(f.text))
    const applied = await fs.readFile(f.filePath, 'utf8')
    f.changeRuntime({ rules: structuredClone(f.original.rules) })
    const reloadCount = f.reloads().length
    expect(await f.adapter.rollback(f.profile, undo)).toBe(false)
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(applied)
    expect(f.runtime().rules).toEqual(f.original.rules)
    expect(f.reloads()).toHaveLength(reloadCount)
  })

  it('retries restoring runtime after rollback wrote the file but its hot reload failed', async () => {
    const f = await fixture()
    const undo = await f.adapter.apply(f.profile, hash(f.text))
    f.failReload()
    await expect(f.adapter.rollback(f.profile, undo)).rejects.toThrow('PROXY_CONTROLLER_UNAVAILABLE')
    expect(await f.read()).toEqual(f.original)
    expect(f.runtime().mode).toBe('rule')
    expect(await f.adapter.rollback(f.profile, undo)).toBe(true)
    expect(f.runtime()).toEqual(f.original)
    expect(f.reloads()).toHaveLength(3)
  })

  it('can retry rollback when restoring YAML rules changes their original formatting', async () => {
    const f = await fixture()
    const formatted = f.text.replace('  - DOMAIN,example.test,Global', '  - "DOMAIN,example.test,Global" # original rule note')
    expect(formatted).not.toBe(f.text)
    await fs.writeFile(f.filePath, formatted)
    const undo = await f.adapter.apply(f.profile, hash(formatted))
    f.failReload()
    await expect(f.adapter.rollback(f.profile, undo)).rejects.toThrow('PROXY_CONTROLLER_UNAVAILABLE')
    expect(await f.adapter.rollback(f.profile, undo)).toBe(true)
    expect(await f.read()).toEqual(f.original)
    expect(f.runtime()).toEqual(f.original)
  })
})
