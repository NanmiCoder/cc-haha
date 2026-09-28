import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createNetworkManagerService } from './service'
import { routePrefixContains } from '../../../src/features/network-manager/routeBinding'
import type { NetworkCommand } from './powershell'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))) })

async function fixture() {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpn-route-binding-'))
  directories.push(configDir)
  const commands: NetworkCommand[] = []
  const vpn = { name: 'Office VPN', scope: 'allUsers', connected: true, splitTunneling: true, routes: [] as { prefix: string; metric: number }[] }
  let selectedStuck = false
  let selectedStuckTarget = ''
  let profileRouteActivates = true
  let vpnInterfaceConnected = true
  let disconnectAfterProfileAdd = false
  let failAdd = false
  let failActiveAdd = false
  let source = '192.168.1.10'
  const activeRoutes: { prefix: string; nextHop: string; interfaceIndex: number; interfaceAlias: string; metric: number; store: string }[] = []
  const directHttp = vi.fn(async (address: string, port: number, protocol: 'http' | 'https') => ({
    target: `${protocol}://${address}:${port}/`, port, kind: 'http-direct' as const, ok: true,
    checkedAt: new Date().toISOString(), latencyMs: 2, statusCode: 200, detail: 'DIRECT_HTTP_RESPONSE',
  }))
  const runner = async (command: NetworkCommand): Promise<unknown> => {
    if (command.action === 'vpnRouteAdd') {
      commands.push(command)
      vpn.routes.push({ prefix: String(command.prefix), metric: Number(command.metric) })
      if (disconnectAfterProfileAdd) vpnInterfaceConnected = false
      if (failAdd) throw new Error('SIMULATED_ADD_ERROR')
      return null
    }
    if (command.action === 'vpnRouteRemove') {
      commands.push(command)
      vpn.routes = vpn.routes.filter(route => route.prefix !== command.prefix)
      return null
    }
    if (command.action === 'routeAdd') {
      commands.push(command)
      activeRoutes.push({ prefix: String(command.prefix), nextHop: String(command.nextHop), interfaceIndex: Number(command.interfaceIndex),
        interfaceAlias: vpn.name, metric: Number(command.metric), store: String(command.store) })
      if (failActiveAdd) throw new Error('SIMULATED_ACTIVE_ADD_ERROR')
      return null
    }
    if (command.action === 'routeRemove') {
      commands.push(command)
      const index = activeRoutes.findIndex(route => route.prefix === command.prefix && route.interfaceIndex === command.interfaceIndex
        && route.nextHop === command.nextHop && route.metric === command.metric && route.store === command.store)
      if (index >= 0) activeRoutes.splice(index, 1)
      return null
    }
    if (command.action !== 'snapshot') throw new Error('UNKNOWN_TEST_COMMAND')
    const targets = command.targets as string[]
    return {
      interfaces: [{ InterfaceIndex: 47, InterfaceAlias: vpn.name, ConnectionState: vpnInterfaceConnected ? 'Connected' : 'Disconnected', InterfaceMetric: 25 }],
      addresses: [{ InterfaceIndex: 4, IPAddress: source, PrefixLength: 24 }, { InterfaceIndex: 47, IPAddress: '162.168.1.2', PrefixLength: 32 }], adapters: [],
      routes: [{ prefix: '10.204.19.0/24', nextHop: '0.0.0.0', interfaceIndex: 51, interfaceAlias: 'zjwj-arm62', metric: 1, store: 'ActiveStore' }, ...activeRoutes],
      vpns: [structuredClone(vpn)],
      selected: targets.map(target => {
        const associated = vpn.routes.find(route => routePrefixContains(route.prefix, target))
        const viaVpn = !selectedStuck && selectedStuckTarget !== target
          && (!!associated && profileRouteActivates || activeRoutes.some(route => routePrefixContains(route.prefix, target)))
        return { target, source: viaVpn ? '162.168.1.2' : source, interfaceIndex: viaVpn ? 47 : 4, interfaceAlias: viaVpn ? vpn.name : 'Ethernet',
          prefix: viaVpn ? activeRoutes.find(route => routePrefixContains(route.prefix, target))?.prefix ?? associated!.prefix : '0.0.0.0/0', nextHop: '0.0.0.0' }
      }),
      service: null, task: null, handshakes: [], admin: true, issues: [],
    }
  }
  const service = createNetworkManagerService({ configDir, platform: 'win32', runner, delay: async () => undefined,
    directHttp, resolveHost: async () => null, openExternal: async () => undefined, openPath: async () => '' })
  const target = { destination: '10.55.1.7', vpnName: vpn.name, vpnScope: 'allUsers' as const }
  return { service, vpn, commands, activeRoutes, target, directHttp, setSelectedStuck: (value: boolean) => { selectedStuck = value },
    setSelectedStuckTarget: (value: string) => { selectedStuckTarget = value }, setProfileRouteActivates: (value: boolean) => { profileRouteActivates = value },
    setVpnInterfaceConnected: (value: boolean) => { vpnInterfaceConnected = value },
    setDisconnectAfterProfileAdd: (value: boolean) => { disconnectAfterProfileAdd = value },
    setFailAdd: (value: boolean) => { failAdd = value }, setFailActiveAdd: (value: boolean) => { failActiveAdd = value },
    setSource: (value: string) => { source = value } }
}

describe('fixed Windows VPN destination binding', () => {
  it('blocks a broad 10/8 association while a more-specific WireGuard route exists', async () => {
    const f = await fixture()
    const result = await f.service.vpnRoutePreview({ ...f.target, destination: '10.0.0.0/8' })
    expect(result.ok && result.data).toMatchObject({ canApply: false, issues: expect.arrayContaining(['VPN_ROUTE_CONFLICT']), conflicts: [expect.objectContaining({ prefix: '10.204.19.0/24' })] })
    expect(f.commands).toEqual([])
  })

  it('adds only the reviewed /32 association and verifies actual selected VPN', async () => {
    const f = await fixture()
    const preview = await f.service.vpnRoutePreview(f.target)
    if (!preview.ok) throw new Error(preview.error.code)
    expect(preview.data).toMatchObject({ destination: '10.55.1.7/32', canApply: true })
    const report = await f.service.vpnRouteApply(preview.data.id)
    expect(report).toMatchObject({ ok: true, data: { status: 'applied', selected: { interfaceAlias: f.vpn.name } } })
    expect(f.commands).toEqual([{ action: 'vpnRouteAdd', name: f.vpn.name, scope: 'allUsers', prefix: '10.55.1.7/32', metric: 1 }])
    expect(await f.service.vpnRouteVerify(f.target)).toMatchObject({ ok: true, data: { alreadyBound: true, canApply: false, issues: ['VPN_ROUTE_ALREADY_BOUND'] } })
  })

  it('rejects stale preview and rolls back an association whose selected route stays elsewhere', async () => {
    const f = await fixture()
    const first = await f.service.vpnRoutePreview(f.target)
    if (!first.ok) throw new Error(first.error.code)
    f.setSource('192.168.1.11')
    expect(await f.service.vpnRouteApply(first.data.id)).toMatchObject({ ok: false, error: { code: 'PLAN_STALE' } })
    expect(f.commands).toEqual([])
    const second = await f.service.vpnRoutePreview(f.target)
    if (!second.ok) throw new Error(second.error.code)
    f.setSelectedStuck(true)
    expect(await f.service.vpnRouteApply(second.data.id)).toMatchObject({ ok: true, data: { status: 'rolled-back', issues: ['VPN_ROUTE_NOT_SELECTED'] } })
    expect(f.commands.map(command => command.action)).toEqual(['vpnRouteAdd', 'routeAdd', 'routeRemove', 'vpnRouteRemove'])
    expect(f.vpn.routes).toEqual([])
  })

  it('preserves an association if a failed add leaves ownership ambiguous', async () => {
    const f = await fixture()
    const preview = await f.service.vpnRoutePreview(f.target)
    if (!preview.ok) throw new Error(preview.error.code)
    f.setFailAdd(true)
    expect(await f.service.vpnRouteApply(preview.data.id)).toMatchObject({ ok: true, data: { status: 'rollback-conflict', issues: expect.arrayContaining(['VPN_ROUTE_OWNERSHIP_UNCERTAIN']) } })
    expect(f.commands.map(command => command.action)).toEqual(['vpnRouteAdd'])
    expect(f.vpn.routes).toHaveLength(1)
  })

  it('previews and applies multiple exact addresses on one reviewed VPN', async () => {
    const f = await fixture()
    const input = { destinations: ['10.0.0.199', '10.55.1.7', '10.55.2.0/24'], vpnName: f.vpn.name, vpnScope: f.target.vpnScope }
    const preview = await f.service.vpnRouteBatchPreview(input)
    if (!preview.ok) throw new Error(preview.error.code)
    expect(preview.data).toMatchObject({ canApply: true, items: [{ destination: '10.0.0.199/32' }, { destination: '10.55.1.7/32' }, { destination: '10.55.2.0/24' }] })
    expect(await f.service.vpnRouteBatchApply(preview.data.id)).toMatchObject({ ok: true, data: { status: 'applied', destinations: ['10.0.0.199/32', '10.55.1.7/32', '10.55.2.0/24'] } })
    expect(f.commands.map(command => command.action)).toEqual(['vpnRouteAdd', 'vpnRouteAdd', 'vpnRouteAdd'])
    expect(await f.service.vpnRouteBatchVerify(input)).toMatchObject({ ok: true, data: { canApply: false, items: [{ alreadyBound: true }, { alreadyBound: true }, { alreadyBound: true }] } })
  })

  it('blocks overlapping targets and duplicates without modifying routes', async () => {
    const f = await fixture()
    const overlapping = await f.service.vpnRouteBatchPreview({ destinations: ['10.55.0.0/16', '10.55.1.7'], vpnName: f.vpn.name, vpnScope: f.target.vpnScope })
    expect(overlapping).toMatchObject({ ok: true, data: { canApply: false, issues: ['VPN_ROUTE_BATCH_OVERLAP'] } })
    expect(await f.service.vpnRouteBatchPreview({ destinations: ['10.55.1.7', '10.55.1.7/32'], vpnName: f.vpn.name, vpnScope: f.target.vpnScope })).toMatchObject({ ok: false, error: { code: 'VPN_ROUTE_BATCH_DUPLICATE' } })
    expect(await f.service.vpnRouteBatchPreview({ destinations: ['10.0.0.199', '0.0.0.0/0'], vpnName: f.vpn.name, vpnScope: f.target.vpnScope })).toMatchObject({ ok: false, error: { code: 'VPN_ROUTE_DESTINATION_INVALID' } })
    expect(f.commands).toEqual([])
  })

  it('reverses earlier additions when a later destination does not select the VPN', async () => {
    const f = await fixture()
    const input = { destinations: ['10.55.1.7', '10.55.1.8'], vpnName: f.vpn.name, vpnScope: f.target.vpnScope }
    const preview = await f.service.vpnRouteBatchPreview(input)
    if (!preview.ok) throw new Error(preview.error.code)
    f.setSelectedStuckTarget('10.55.1.8')
    expect(await f.service.vpnRouteBatchApply(preview.data.id)).toMatchObject({ ok: true, data: { status: 'rolled-back', issues: ['VPN_ROUTE_NOT_SELECTED'] } })
    expect(f.commands.map(command => command.action)).toEqual(['vpnRouteAdd', 'vpnRouteAdd', 'routeAdd', 'routeRemove', 'vpnRouteRemove', 'vpnRouteRemove'])
    expect(f.vpn.routes).toEqual([])
  })

  it('adds an exact active route on the verified connected VPN interface when the profile association is not yet active', async () => {
    const f = await fixture()
    f.setProfileRouteActivates(false)
    const preview = await f.service.vpnRoutePreview({ ...f.target, destination: '10.0.0.199' })
    if (!preview.ok) throw new Error(preview.error.code)
    expect(await f.service.vpnRouteApply(preview.data.id)).toMatchObject({ ok: true, data: { status: 'applied', selected: { interfaceAlias: f.vpn.name } } })
    expect(f.commands).toEqual([
      { action: 'vpnRouteAdd', name: f.vpn.name, scope: 'allUsers', prefix: '10.0.0.199/32', metric: 1 },
      { action: 'routeAdd', prefix: '10.0.0.199/32', interfaceIndex: 47, nextHop: '0.0.0.0', metric: 1, store: 'ActiveStore' },
    ])
    expect(f.activeRoutes).toEqual([expect.objectContaining({ prefix: '10.0.0.199/32', interfaceIndex: 47, store: 'ActiveStore' })])
  })

  it('uses exact active routes for every destination in a batch without widening the prefix', async () => {
    const f = await fixture()
    f.setProfileRouteActivates(false)
    const input = { destinations: ['10.0.0.199', '10.55.1.7'], vpnName: f.vpn.name, vpnScope: f.target.vpnScope }
    const preview = await f.service.vpnRouteBatchPreview(input)
    if (!preview.ok) throw new Error(preview.error.code)
    expect(await f.service.vpnRouteBatchApply(preview.data.id)).toMatchObject({ ok: true, data: { status: 'applied' } })
    expect(f.activeRoutes.map(route => route.prefix)).toEqual(['10.0.0.199/32', '10.55.1.7/32'])
  })

  it('preserves a pre-existing exact active route and removes only its newly added profile association on failure', async () => {
    const f = await fixture()
    f.setProfileRouteActivates(false)
    f.setSelectedStuck(true)
    f.activeRoutes.push({ prefix: '10.55.1.7/32', nextHop: '0.0.0.0', interfaceIndex: 47, interfaceAlias: f.vpn.name, metric: 9, store: 'ActiveStore' })
    const preview = await f.service.vpnRoutePreview(f.target)
    if (!preview.ok) throw new Error(preview.error.code)
    expect(await f.service.vpnRouteApply(preview.data.id)).toMatchObject({ ok: true, data: { status: 'rolled-back', issues: ['VPN_ROUTE_NOT_SELECTED'] } })
    expect(f.commands.map(command => command.action)).toEqual(['vpnRouteAdd', 'vpnRouteRemove'])
    expect(f.activeRoutes).toHaveLength(1)
    expect(f.vpn.routes).toEqual([])
  })

  it('preserves ambiguous active route ownership when adding it fails after mutation', async () => {
    const f = await fixture()
    f.setProfileRouteActivates(false)
    f.setFailActiveAdd(true)
    const preview = await f.service.vpnRoutePreview(f.target)
    if (!preview.ok) throw new Error(preview.error.code)
    expect(await f.service.vpnRouteApply(preview.data.id)).toMatchObject({ ok: true, data: { status: 'rollback-conflict', issues: expect.arrayContaining(['VPN_ROUTE_OWNERSHIP_UNCERTAIN']) } })
    expect(f.commands.map(command => command.action)).toEqual(['vpnRouteAdd', 'routeAdd'])
    expect(f.activeRoutes).toHaveLength(1)
    expect(f.vpn.routes).toHaveLength(1)
  })

  it('refuses to bind to an unverified VPN interface and rolls back only the new association', async () => {
    const f = await fixture()
    f.setProfileRouteActivates(false)
    const preview = await f.service.vpnRoutePreview(f.target)
    if (!preview.ok) throw new Error(preview.error.code)
    f.setDisconnectAfterProfileAdd(true)
    expect(await f.service.vpnRouteApply(preview.data.id)).toMatchObject({ ok: true, data: { status: 'rolled-back', issues: ['VPN_ROUTE_INTERFACE_UNVERIFIED'] } })
    expect(f.commands.map(command => command.action)).toEqual(['vpnRouteAdd', 'vpnRouteRemove'])
    expect(f.vpn.routes).toEqual([])
  })

  it('rolls back both new route layers for earlier batch items while retaining an unrelated route', async () => {
    const f = await fixture()
    f.setProfileRouteActivates(false)
    f.activeRoutes.push({ prefix: '10.99.0.0/16', nextHop: '0.0.0.0', interfaceIndex: 60, interfaceAlias: 'Other VPN', metric: 8, store: 'ActiveStore' })
    const input = { destinations: ['10.55.1.7', '10.55.1.8'], vpnName: f.vpn.name, vpnScope: f.target.vpnScope }
    const preview = await f.service.vpnRouteBatchPreview(input)
    if (!preview.ok) throw new Error(preview.error.code)
    f.setSelectedStuckTarget('10.55.1.8')
    expect(await f.service.vpnRouteBatchApply(preview.data.id)).toMatchObject({ ok: true, data: { status: 'rolled-back' } })
    expect(f.activeRoutes).toEqual([expect.objectContaining({ prefix: '10.99.0.0/16', interfaceIndex: 60 })])
    expect(f.vpn.routes).toEqual([])
    expect(f.commands.map(command => command.action)).toEqual([
      'vpnRouteAdd', 'routeAdd', 'vpnRouteAdd', 'routeAdd',
      'routeRemove', 'vpnRouteRemove', 'routeRemove', 'vpnRouteRemove',
    ])
  })

  it('checks the selected VPN before probing direct HTTP to an exact target', async () => {
    const f = await fixture()
    const input = { address: '10.0.0.199', port: 80, protocol: 'http' as const, vpnName: f.vpn.name, vpnScope: f.target.vpnScope }
    expect(await f.service.vpnRouteProbe(input)).toMatchObject({ ok: true, data: { viaVpn: false, probe: null, issues: ['VPN_ROUTE_NOT_SELECTED'] } })
    expect(f.directHttp).not.toHaveBeenCalled()
    f.vpn.routes.push({ prefix: '10.0.0.199/32', metric: 1 })
    expect(await f.service.vpnRouteProbe(input)).toMatchObject({ ok: true, data: { viaVpn: true, probe: { ok: true, statusCode: 200, kind: 'http-direct' }, issues: [] } })
    expect(f.directHttp).toHaveBeenCalledWith('10.0.0.199', 80, 'http')
    expect(await f.service.vpnRouteProbe({ ...input, address: '10.0.0.0/24' })).toMatchObject({ ok: false, error: { code: 'VPN_ROUTE_PROBE_INVALID' } })
  })
})
