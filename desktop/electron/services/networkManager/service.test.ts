import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createNetworkManagerService } from './service'
import { createDefaultNetworkProfiles, type NetworkProbe, type NetworkResult } from '../../../src/features/network-manager/networkTypes'
import { hash, type ProxyAdapter } from './proxy'
import type { NetworkCommand } from './powershell'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))) })
const unwrap = <T>(result: NetworkResult<T>): T => { if (!result.ok) throw new Error(result.error.code); return result.data }

async function fixture(mode: 'home' | 'work' = 'home', linkedRouteStores = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-manager-test-'))
  directories.push(directory)
  const profile = { ...createDefaultNetworkProfiles()[mode === 'home' ? 0 : 1], proxyConfigPath: 'C:\\fixture\\config.yaml' }
  const timestamp = Date.now()
  const state = {
    interfaces: [
      { InterfaceIndex: 4, InterfaceAlias: 'Ethernet', ConnectionState: 1, InterfaceMetric: 10 },
      { InterfaceIndex: 47, InterfaceAlias: profile.vpnName, ConnectionState: 1, InterfaceMetric: 20 },
      { InterfaceIndex: 51, InterfaceAlias: profile.tunnelName, ConnectionState: 1, InterfaceMetric: 5 },
    ],
    addresses: [{ InterfaceIndex: 4, IPAddress: mode === 'work' ? '191.168.3.50' : '192.168.1.50', PrefixLength: 21 }, { InterfaceIndex: 47, IPAddress: '162.168.1.2', PrefixLength: 32 }],
    adapters: [{ InterfaceIndex: 4, InterfaceGuid: 'physical-guid', Status: 'Up' }],
    routes: [] as { prefix: string; nextHop: string; interfaceIndex: number; interfaceAlias: string; metric: number; store: string }[],
    vpns: [{ name: profile.vpnName, scope: profile.vpnScope, connected: true, splitTunneling: true, routes: [{ prefix: profile.managementPrefix, metric: 1 }] }],
    selected: [
      { target: profile.gatewayAddress, source: mode === 'home' ? '162.168.1.2' : '191.168.3.50', interfaceIndex: mode === 'home' ? 47 : 4, interfaceAlias: mode === 'home' ? profile.vpnName : 'Ethernet', prefix: mode === 'home' ? profile.managementPrefix : '191.168.0.0/21', nextHop: '0.0.0.0' },
      { target: profile.containerProbeAddress, source: mode === 'home' ? '10.78.62.2' : '191.168.3.50', interfaceIndex: mode === 'home' ? 51 : 4, interfaceAlias: mode === 'home' ? profile.tunnelName : 'Ethernet', prefix: profile.containerPrefix, nextHop: mode === 'home' ? '0.0.0.0' : profile.gatewayAddress },
      { target: '1.1.1.1', source: '192.168.1.50', interfaceIndex: 4, interfaceAlias: 'Ethernet', prefix: '0.0.0.0/0', nextHop: '192.168.1.1' },
    ],
    service: { Name: `WireGuardTunnel$${profile.tunnelName}`, status: 'Running', startType: 'Automatic' },
    task: { TaskName: profile.relayTaskName, state: 'Running', enabled: true },
    handshakes: [Math.floor(timestamp / 1000)], admin: true, issues: [],
  }
  const commands: NetworkCommand[] = []
  let afterCommand: ((command: NetworkCommand) => void | Promise<void>) | undefined
  let afterTcp: ((target: string) => void) | undefined
  let tcpPass = true
  const tcp = async (target: string, port: number): Promise<NetworkProbe> => {
    afterTcp?.(target)
    return { target, port, kind: 'tcp', ok: tcpPass, checkedAt: new Date(timestamp).toISOString(), latencyMs: 1, detail: tcpPass ? 'TCP_CONNECTED' : 'TCP_UNREACHABLE' }
  }
  const proxyState = { available: true, mode: 'rule', tunEnabled: false, controller: 'http://127.0.0.1:39797', bypassPrefixes: [profile.managementPrefix, profile.containerPrefix], configHash: hash('original') }
  const proxy: ProxyAdapter = {
    inspect: async () => structuredClone(proxyState),
    apply: async (_profile, _expected, prepared) => {
      const undo = { path: profile.proxyConfigPath, beforeRules: [], beforeMode: 'rule', beforeHash: hash('original'), afterHash: hash('changed'), restoredHash: hash('original'), runtimeBeforeMode: 'rule', runtimeAfterMode: 'rule' as const, runtimeRulesHash: hash([]), afterRuntimeRulesHash: hash([]), controlPathHash: hash({}) }
      await prepared?.(undo)
      proxyState.configHash = undo.afterHash
      return undo
    },
    rollback: async () => { proxyState.configHash = hash('original'); return true },
  }
  const discoveryState = { running: false, cores: [], issues: [] }
  const runner = async (command: NetworkCommand): Promise<unknown> => {
    if (command.action === 'snapshot') return structuredClone(state)
    if (command.action === 'proxyDiscover') return structuredClone(discoveryState)
    commands.push(command)
    switch (command.action) {
      case 'split': state.vpns[0]!.splitTunneling = Boolean(command.enabled); break
      case 'vpnRouteAdd': state.vpns[0]!.routes.push({ prefix: String(command.prefix), metric: Number(command.metric) }); break
      case 'vpnRouteRemove': state.vpns[0]!.routes = state.vpns[0]!.routes.filter(route => route.prefix !== command.prefix); break
      case 'service': state.service.status = command.running ? 'Running' : 'Stopped'; break
      case 'serviceStartup': state.service.startType = String(command.startType); break
      case 'task': state.task.state = command.running ? 'Running' : 'Ready'; break
      case 'taskEnabled': state.task.enabled = Boolean(command.enabled); break
      case 'routeAdd': {
        const route = { prefix: String(command.prefix), nextHop: String(command.nextHop), interfaceIndex: Number(command.interfaceIndex), interfaceAlias: 'Ethernet', metric: Number(command.metric), store: String(command.store) }
        state.routes.push(route)
        if (linkedRouteStores && route.store === 'PersistentStore' && !state.routes.some(item => item.prefix === route.prefix && item.store === 'ActiveStore')) state.routes.push({ ...route, store: 'ActiveStore' })
        break
      }
      case 'routeRemove': state.routes = state.routes.filter(route => !(route.prefix === command.prefix && route.nextHop === command.nextHop && route.interfaceIndex === command.interfaceIndex && (route.store === command.store || (linkedRouteStores && command.store === 'PersistentStore')))); break
      default: throw new Error('UNKNOWN_TEST_OPERATION')
    }
    await afterCommand?.(command)
    return null
  }
  let clock = timestamp
  const service = createNetworkManagerService({ configDir: directory, platform: 'win32', runner, proxy, tcp,
    http: async target => ({ target, kind: 'http-proxy', ok: true, checkedAt: new Date(timestamp).toISOString(), latencyMs: 1, detail: 'EXPLICIT_PROXY_HTTP_RESPONSE' }),
    now: () => clock, delay: async () => undefined,
    resolveHost: async id => id === '11111111-1111-4111-8111-111111111111' ? { id, name: 'fixture', address: '191.168.7.62', port: 2222 } : null,
    openExternal: async url => { commands.push({ action: 'openExternal', url }) }, openPath: async file => { commands.push({ action: 'openPath', file }); return '' },
  })
  return { directory, profile, state, commands, service, proxyState, discoveryState, setAfterCommand: (callback: typeof afterCommand) => { afterCommand = callback }, setAfterTcp: (callback: typeof afterTcp) => { afterTcp = callback }, setTcp: (pass: boolean) => { tcpPass = pass }, setClock: (value: number) => { clock = value }, timestamp }
}

describe('network manager deterministic orchestration', () => {
  it('returns a read-only catalogue and the exact native command/inverse of a reviewed plan', async () => {
    const f = await fixture()
    const catalog = unwrap(await f.service.executionCatalog())
    expect(catalog.actions.some(action => action.id === 'split' && action.script.includes('Set-VpnConnection'))).toBe(true)
    expect(f.commands).toHaveLength(0)
    f.state.vpns[0]!.splitTunneling = false
    const plan = unwrap(await f.service.plan(f.profile)).plan
    const execution = plan.execution!.find(item => item.id === 'vpn-split')!
    expect(execution.command).toMatchObject({ action: 'split', enabled: true })
    expect(execution.inverse).toMatchObject({ action: 'split', enabled: false })
    expect(f.commands).toHaveLength(0)
    expect(unwrap(await f.service.apply(plan.id)).status).toBe('applied')
    expect(f.commands[0]).toEqual(execution.command)
  })

  it('does not relaunch an already running Sakura GUI even if its core/config is unresolved', async () => {
    const f = await fixture()
    f.discoveryState.running = true
    expect(unwrap(await f.service.discoverProxy(7897))).toMatchObject({ status: 'incomplete', running: true })
    expect(unwrap(await f.service.login('sakura', f.profile))).toBeNull()
    expect(f.commands).toHaveLength(0)
  })

  it('invalidates a reviewed plan when the proxy process identity changes', async () => {
    const f = await fixture()
    Object.assign(f.proxyState, { instanceId: '101:old-start' })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    Object.assign(f.proxyState, { instanceId: '101:new-start' })
    expect(await f.service.apply(plan.id)).toMatchObject({ ok: false, error: { code: 'PLAN_STALE' } })
    expect(f.commands).toHaveLength(0)
  })

  it('loads defaults and migrates an old configuration on save with revision conflict protection', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.directory, 'network-modes.json'), JSON.stringify({ schemaVersion: 0, profiles: [{ id: 'home', mode: 'home', name: '旧家庭网络' }] }))
    const old = unwrap(await f.service.list())
    expect(old.profiles[0]?.name).toBe('旧家庭网络')
    const saved = unwrap(await f.service.save(f.profile, 0))
    expect(saved.revision).toBe(1)
    expect(await f.service.save(f.profile, 0)).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
  })

  it('refuses a 31st profile without corrupting persisted configuration', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.directory, 'network-modes.json'), JSON.stringify({ schemaVersion: 1, revision: 0, profiles: Array.from({ length: 30 }, (_, i) => ({ ...f.profile, id: `profile-${i}` })) }))
    expect(await f.service.save({ ...f.profile, id: 'extra' }, 0)).toMatchObject({ ok: false, error: { code: 'PROFILE_LIMIT' } })
    expect(unwrap(await f.service.list()).profiles).toHaveLength(30)
  })

  it('blocks disconnected scoped VPN and changed outer source before any mutation', async () => {
    const f = await fixture()
    f.state.vpns[0]!.connected = false
    expect(unwrap(await f.service.plan(f.profile)).plan).toMatchObject({ canApply: false })
    f.state.vpns[0]!.connected = true
    f.state.selected[0]!.source = '162.168.1.9'
    const planned = unwrap(await f.service.plan(f.profile))
    expect(planned.plan.steps.some(step => step.code === 'sourceAclMismatch')).toBe(true)
    expect(await f.service.apply(planned.plan.id)).toMatchObject({ ok: false, error: { code: 'PLAN_BLOCKED' } })
    expect(f.commands).toHaveLength(0)
  })

  it('allows a proxy-only hot reload without elevating the application', async () => {
    const f = await fixture()
    f.state.admin = false
    f.proxyState.bypassPrefixes = []
    const plan = unwrap(await f.service.plan({ ...f.profile, containerEnabled: false })).plan
    expect(plan.canApply).toBe(true)
    expect(plan.changes.map(change => change.id)).toEqual(['proxy-bypass'])
    expect(plan.steps.some(step => step.code === 'elevationRequired')).toBe(false)
  })

  it('accepts an existing broad 10/8 DIRECT rule for the configured container subnet', async () => {
    const f = await fixture()
    f.proxyState.bypassPrefixes = [f.profile.managementPrefix, '10.0.0.0/8']
    const plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.steps.find(step => step.id === 'proxy')).toMatchObject({ state: 'ready' })
    expect(plan.changes.some(change => change.id === 'proxy-bypass')).toBe(false)
    expect(unwrap(await f.service.verify(f.profile)).find(probe => probe.kind === 'http-proxy')).toMatchObject({ ok: true })
  })

  it('does not pretend a VPN /16 overrides physical /21 or an old container /32', async () => {
    const f = await fixture()
    f.state.vpns[0]!.routes = []
    Object.assign(f.state.selected[0]!, { prefix: '191.168.0.0/21', interfaceIndex: 4, interfaceAlias: 'Ethernet' })
    let plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.canApply).toBe(false)
    f.state.routes.push({ prefix: '10.204.19.81/32', nextHop: '191.168.7.151', interfaceIndex: 4, interfaceAlias: 'Ethernet', metric: 100, store: 'ActiveStore' })
    plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.steps.some(step => step.code === 'routeConflict')).toBe(true)
  })

  it('rejects stale or expired plans and never trusts renderer-crafted changes', async () => {
    const f = await fixture()
    let plan = unwrap(await f.service.plan(f.profile)).plan
    f.state.selected[0]!.source = '162.168.1.7'
    expect(await f.service.apply(plan.id)).toMatchObject({ ok: false, error: { code: 'PLAN_STALE' } })
    f.state.selected[0]!.source = '162.168.1.2'
    plan = unwrap(await f.service.plan(f.profile)).plan
    f.setClock(f.timestamp + 120_001)
    expect(await f.service.apply(plan.id)).toMatchObject({ ok: false, error: { code: 'PLAN_EXPIRED' } })
    expect(f.commands).toHaveLength(0)
  })

  it('journals before mutation and reverses a command that partially succeeds then throws', async () => {
    const f = await fixture()
    f.state.vpns[0]!.splitTunneling = false
    let failed = false
    f.setAfterCommand(async command => {
      if (command.action === 'split' && command.enabled && !failed) {
        const journal = JSON.parse(await fs.readFile(path.join(f.directory, 'network-apply-journal.json'), 'utf8'))
        expect(journal.entries[0].completed).toBe(false)
        failed = true
        throw new Error('INJECTED_FAILURE')
      }
    })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    const result = unwrap(await f.service.apply(plan.id))
    expect(result.status).toBe('rolled-back')
    expect(f.state.vpns[0]!.splitTunneling).toBe(false)
    expect(f.commands.map(command => command.enabled)).toEqual([true, false])
  })

  it('preserves a route edited by another writer during failure rollback', async () => {
    const f = await fixture()
    f.state.vpns[0]!.routes = []
    f.setAfterCommand(command => {
      if (command.action === 'vpnRouteAdd') { f.state.vpns[0]!.routes[0]!.metric = 99; throw new Error('INJECTED_FAILURE') }
    })
    const result = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(result.status).toBe('rollback-conflict')
    expect(f.state.vpns[0]!.routes[0]!.metric).toBe(99)
    expect(f.commands.some(command => command.action === 'vpnRouteRemove')).toBe(false)
  })

  it('recovers an interrupted inverse once and does not replay already-restored entries', async () => {
    const f = await fixture()
    f.state.vpns[0]!.splitTunneling = false
    f.state.vpns[0]!.routes = []
    let restorationFailed = false
    f.setAfterCommand(command => {
      if (command.action === 'vpnRouteAdd') throw new Error('INJECTED_FAILURE')
      if (command.action === 'split' && !command.enabled && !restorationFailed) { restorationFailed = true; throw new Error('INJECTED_RESTORE_FAILURE') }
    })
    expect(unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id)).status).toBe('rollback-conflict')
    expect(unwrap(await f.service.plan(f.profile)).plan.steps.some(step => step.code === 'recoveryRequired')).toBe(true)
    expect(unwrap(await f.service.recover()).status).toBe('rolled-back')
    expect(f.commands.filter(command => command.action === 'vpnRouteRemove')).toHaveLength(1)
    expect(await f.service.recover()).toMatchObject({ ok: false, error: { code: 'NO_PENDING_RECOVERY' } })
  })

  it.each([false, true])('switches work to home while preserving the corporate VPN, linked route stores=%s', async linked => {
    const f = await fixture('work', linked)
    let report = unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id))
    expect(report.status).toBe('applied')
    expect(f.state.service.status).toBe('Stopped')
    expect(f.state.task.enabled).toBe(false)
    expect(f.state.vpns[0]!.connected).toBe(true)
    expect(f.state.routes.map(route => route.store).sort()).toEqual(['ActiveStore', 'PersistentStore'])
    const home = { ...f.profile, id: 'home', mode: 'home' as const }
    Object.assign(f.state.selected[0]!, { source: '162.168.1.2', interfaceIndex: 47, interfaceAlias: home.vpnName, prefix: home.managementPrefix })
    Object.assign(f.state.selected[1]!, { source: '10.78.62.2', interfaceIndex: 51, interfaceAlias: home.tunnelName, nextHop: '0.0.0.0' })
    report = unwrap(await f.service.apply(unwrap(await f.service.plan(home)).plan.id))
    expect(report.status).toBe('applied')
    expect(f.state.routes).toHaveLength(0)
    expect(f.state.service.status).toBe('Running')
    expect(f.commands.every(command => !String(command.name).includes('ops-server'))).toBe(true)
  })

  it('retains independently owned active routes and blocks their deletion on a later home switch', async () => {
    const f = await fixture('work')
    f.state.routes.push({ prefix: f.profile.containerPrefix, nextHop: f.profile.gatewayAddress, interfaceIndex: 4, interfaceAlias: 'Ethernet', metric: 5, store: 'ActiveStore' })
    expect(unwrap(await f.service.apply(unwrap(await f.service.plan(f.profile)).plan.id)).status).toBe('applied')
    const home = { ...f.profile, mode: 'home' as const }
    Object.assign(f.state.selected[0]!, { source: '162.168.1.2', interfaceIndex: 47, interfaceAlias: home.vpnName, prefix: home.managementPrefix })
    expect(unwrap(await f.service.plan(home)).plan.canApply).toBe(false)
    expect(f.state.routes.find(route => route.store === 'ActiveStore')).toBeDefined()
  })

  it('blocks an unowned office route instead of silently deleting it for home mode', async () => {
    const f = await fixture()
    f.state.routes.push({ prefix: f.profile.containerPrefix, nextHop: f.profile.gatewayAddress, interfaceIndex: 4, interfaceAlias: 'Ethernet', metric: 5, store: 'PersistentStore' })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    expect(plan.canApply).toBe(false)
    expect(plan.steps.some(step => step.code === 'routeConflict')).toBe(true)
  })

  it('generates traffic before measuring a fresh handshake and verifies the work next hop', async () => {
    const f = await fixture()
    f.state.handshakes = [0]
    f.setAfterTcp(target => { if (target === f.profile.containerProbeAddress) f.state.handshakes = [Math.floor(f.timestamp / 1000)] })
    const probes = unwrap(await f.service.verify(f.profile))
    expect(probes.find(probe => probe.kind === 'handshake')?.ok).toBe(true)
    const work = await fixture('work')
    work.state.selected[1]!.nextHop = '191.168.7.151'
    expect(unwrap(await work.service.verify(work.profile)).find(probe => probe.kind === 'route' && probe.target === work.profile.containerProbeAddress)?.ok).toBe(false)
    f.proxyState.bypassPrefixes = []
    expect(unwrap(await f.service.verify(f.profile)).find(probe => probe.kind === 'http-proxy')).toMatchObject({ ok: false, detail: 'PROXY_CONFIGURATION_MISMATCH' })
  })

  it('refuses a tampered recovery command and resolves manual host probes from the authoritative store', async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.directory, 'network-apply-journal.json'), JSON.stringify({ schemaVersion: 1, planId: 'old', profile: f.profile, status: 'applying', entries: [{ id: 'tunnel-stop', completed: true, operation: { id: 'tunnel-stop', command: { action: 'service', name: 'UnrelatedService', running: false }, inverse: { action: 'service', name: 'UnrelatedService', running: true }, before: true, after: false } }] }))
    expect(await f.service.recover()).toMatchObject({ ok: false, error: { code: 'RECOVERY_JOURNAL_INVALID' } })
    expect(f.commands).toHaveLength(0)
    expect(unwrap(await f.service.probeHost('11111111-1111-4111-8111-111111111111'))).toMatchObject({ target: '191.168.7.62', port: 2222, hostId: '11111111-1111-4111-8111-111111111111' })
  })

  it('opens OS login without credentials and blocks a concurrent apply', async () => {
    const f = await fixture()
    unwrap(await f.service.login('vpn', f.profile))
    expect(f.commands[0]).toEqual({ action: 'openExternal', url: 'ms-settings:network-vpn' })
    f.state.vpns[0]!.splitTunneling = false
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    f.setAfterCommand(async () => { entered(); await gate })
    const plan = unwrap(await f.service.plan(f.profile)).plan
    const first = f.service.apply(plan.id)
    await started
    expect(await f.service.apply(plan.id)).toMatchObject({ ok: false, error: { code: 'NETWORK_BUSY' } })
    release()
    expect(unwrap(await first).status).toBe('applied')
  })
})
