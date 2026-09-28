import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  NetworkApplyReport, NetworkChange, NetworkManagerApi, NetworkPlan, NetworkProbe,
  NetworkProfile, NetworkResult, NetworkSnapshot, NetworkStep, VpnRouteApplyReport,
  VpnRouteBatchInput, VpnRouteBatchPlan, VpnRouteBatchReport, VpnRoutePlan, VpnRouteSelection, VpnRouteTarget,
} from '../../../src/features/network-manager/networkTypes'
import { proxyBypassCovers } from '../../../src/features/network-manager/networkTypes'
import { parseRoutePrefix, routePrefixContains, routePrefixOverlaps, routeProbeAddress } from '../../../src/features/network-manager/routeBinding'
import { isAddressInPrefix, NetworkProfileSchema } from '../../../src/features/network-manager/networkSchemas'
import { createNetworkRepository, writePrivateJson } from './repository'
import { createProxyAdapter, hash, type ProxyAdapter, type ProxyUndo } from './proxy'
import { probeDirectHttp, probeHttpProxy, probeTcp, type DirectHttpProbe, type HttpProbe, type TcpProbe } from './probes'
import { runNetworkPowerShell, type NetworkCommand, type NetworkRunner } from './powershell'
import { discoverSakura } from './proxyDiscovery'
import { getNetworkExecutionCatalog } from './executionCatalog'

type RawSnapshot = {
  interfaces: { InterfaceIndex: number; InterfaceAlias: string; ConnectionState: number | string; InterfaceMetric: number }[]
  addresses: { InterfaceIndex: number; IPAddress: string; PrefixLength: number }[]
  adapters: { InterfaceIndex: number; InterfaceGuid: string; Status: string }[]
  routes: { prefix: string; nextHop: string; interfaceIndex: number; interfaceAlias: string; metric: number; store: string }[]
  vpns: { name: string; scope: string; connected: boolean; splitTunneling: boolean; routes: { prefix: string; metric: number }[] }[]
  selected: NetworkSnapshot['selectedRoutes']
  service: { Name: string; status: string; startType: string } | null
  task: { TaskName: string; state: string; enabled: boolean } | null
  handshakes: number[]
  admin: boolean
  issues: string[]
}
type Observation = { snapshot: NetworkSnapshot; raw: RawSnapshot; ownedRoutes: Operation[] }
type Operation = { id: string; command: NetworkCommand; inverse: NetworkCommand; before: unknown; after: unknown; interfaceGuid?: string }
type JournalEntry = { id: string; operation?: Operation; proxy?: ProxyUndo; completed: boolean; restored?: boolean }
type Journal = { schemaVersion: 1; planId: string; profile: NetworkProfile; status: 'applying' | 'applied' | 'rolled-back' | 'rollback-conflict'; entries: JournalEntry[] }
type StoredPlan = { profile: NetworkProfile; observation: Observation; plan: NetworkPlan; fingerprint: string; operations: Operation[] }
type BindingObservation = { raw: RawSnapshot; selected: VpnRoutePlan['selected']; fingerprint: string }
type StoredBindingPlan = { plan: VpnRoutePlan; fingerprint: string }
type BindingBatchObservation = { raw: RawSnapshot; selected: Map<string, VpnRouteSelection>; fingerprint: string }
type StoredBindingBatchPlan = { plan: VpnRouteBatchPlan; fingerprint: string }
type ActiveBindingRoute = { prefix: string; interfaceIndex: number; nextHop: '0.0.0.0'; metric: 1; store: 'ActiveStore' }
type BindingChange = { destination: string; profileAttempted: boolean; profileAdded: boolean; activeAttempted: boolean; activeRoute: ActiveBindingRoute | null }
export type NetworkManagerOptions = {
  configDir: string
  resolveHost: (id: string) => Promise<{ id: string; name: string; address: string; port: number } | null>
  openExternal: (url: string) => Promise<void>
  openPath: (filePath: string) => Promise<string>
  platform?: string
  runner?: NetworkRunner
  proxy?: ProxyAdapter
  tcp?: TcpProbe
  http?: HttpProbe
  directHttp?: DirectHttpProbe
  now?: () => number
  delay?: (milliseconds: number) => Promise<void>
}

const emptyRaw = (): RawSnapshot => ({ interfaces: [], addresses: [], adapters: [], routes: [], vpns: [], selected: [], service: null, task: null, handshakes: [], admin: false, issues: [] })
const failure = <T>(error: unknown): NetworkResult<T> => {
  const value = error instanceof Error ? error.message : ''
  const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(value) ? value : 'NETWORK_OPERATION_FAILED'
  return { ok: false, error: { code, message: code } }
}
const safe = async <T>(task: () => Promise<T>): Promise<NetworkResult<T>> => {
  try { return { ok: true, data: await task() } } catch (error) { return failure(error) }
}
const profileInput = (value: NetworkProfile) => {
  const parsed = NetworkProfileSchema.safeParse(value)
  if (!parsed.success) throw new Error('INVALID_NETWORK_PROFILE')
  return parsed.data
}
const serviceName = (profile: NetworkProfile) => `WireGuardTunnel$${profile.tunnelName}`
function validateJournalEntry(entry: JournalEntry, profile: NetworkProfile): void {
  const reject = () => { throw new Error('RECOVERY_JOURNAL_INVALID') }
  if (!entry || typeof entry.id !== 'string' || typeof entry.completed !== 'boolean' || (entry.restored !== undefined && typeof entry.restored !== 'boolean')) reject()
  if (entry.proxy) {
    const undo = entry.proxy
    if (entry.operation || entry.id !== 'proxy-bypass' || undo.path !== profile.proxyConfigPath
      || ![undo.afterHash, undo.beforeHash, undo.restoredHash, undo.runtimeRulesHash, undo.controlPathHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
      || (undo.afterRuntimeRulesHash !== undefined && !/^[a-f0-9]{64}$/.test(undo.afterRuntimeRulesHash))
      || (entry.completed && !undo.afterRuntimeRulesHash)
      || !['rule', 'global', 'direct'].includes(undo.runtimeBeforeMode) || undo.runtimeAfterMode !== 'rule'
      || (undo.beforeMode !== undefined && !['rule', 'global', 'direct'].includes(String(undo.beforeMode)))
      || (undo.beforeRules !== undefined && (!Array.isArray(undo.beforeRules) || undo.beforeRules.length > 100_000 || undo.beforeRules.some(rule => typeof rule !== 'string')))) reject()
    return
  }
  const operation = entry.operation
  if (!operation || operation.id !== entry.id) return reject()
  const a = operation.command
  const b = operation.inverse
  if (!a || !b || typeof a.action !== 'string' || typeof b.action !== 'string') return reject()
  let before: unknown
  let after: unknown
  let expected: NetworkCommand
  switch (a.action) {
    case 'split':
      if (a.name !== profile.vpnName || a.scope !== profile.vpnScope || typeof a.enabled !== 'boolean') return reject()
      before = !a.enabled; after = a.enabled
      expected = { action: 'split', name: a.name, scope: a.scope, enabled: before }
      break
    case 'vpnRouteAdd':
      if (a.name !== profile.vpnName || a.scope !== profile.vpnScope || a.prefix !== profile.managementPrefix || a.metric !== 1) return reject()
      before = false; after = true
      expected = { action: 'vpnRouteRemove', name: a.name, scope: a.scope, prefix: a.prefix }
      break
    case 'service':
    case 'task':
      if (a.name !== (a.action === 'service' ? serviceName(profile) : profile.relayTaskName) || typeof a.running !== 'boolean') return reject()
      before = !a.running; after = a.running
      expected = { action: a.action, name: a.name, running: before }
      break
    case 'taskEnabled':
      if (a.name !== profile.relayTaskName || typeof a.enabled !== 'boolean') return reject()
      before = !a.enabled; after = a.enabled
      expected = { action: a.action, name: a.name, enabled: before }
      break
    case 'serviceStartup':
      if (a.name !== serviceName(profile) || !['Automatic', 'Manual', 'Disabled'].includes(String(a.startType)) || !['Automatic', 'Manual', 'Disabled'].includes(String(b.startType))) return reject()
      before = b.startType; after = a.startType
      expected = { action: a.action, name: a.name, startType: before }
      break
    case 'routeAdd':
    case 'routeRemove':
      if (a.prefix !== profile.containerPrefix || a.nextHop !== profile.gatewayAddress || !Number.isInteger(a.interfaceIndex) || Number(a.interfaceIndex) < 1 || !Number.isInteger(a.metric) || Number(a.metric) < 0 || Number(a.metric) > 65535 || !['ActiveStore', 'PersistentStore'].includes(String(a.store)) || typeof operation.interfaceGuid !== 'string' || !operation.interfaceGuid) return reject()
      before = a.action === 'routeRemove'; after = !before
      expected = { ...a, action: a.action === 'routeAdd' ? 'routeRemove' : 'routeAdd' }
      break
    default: return reject()
  }
  const canonical = (value: unknown) => JSON.stringify(Object.entries(value as object).sort(([left], [right]) => left.localeCompare(right)))
  if (canonical(b) !== canonical(expected) || operation.before !== before || operation.after !== after) reject()
  // Extra PowerShell parameters must not be smuggled through a damaged recovery file.
  const keys = new Set(Object.keys(expected))
  if (a.action === 'vpnRouteAdd') keys.add('metric')
  if (Object.keys(a).some(key => !keys.has(key))) reject()
}
const stableSnapshot = (observation: Observation) => hash({
  interfaces: observation.snapshot.interfaces,
  routes: observation.snapshot.routes,
  selected: observation.snapshot.selectedRoutes,
  vpn: observation.snapshot.vpn,
  proxy: observation.snapshot.proxy,
  tunnel: { ...observation.snapshot.tunnel, latestHandshake: undefined },
  adapters: observation.raw.adapters,
  startup: observation.raw.service?.startType,
})

export function createNetworkManagerService(options: NetworkManagerOptions): NetworkManagerApi & { recover(): Promise<NetworkResult<NetworkApplyReport>> } {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? runNetworkPowerShell
  const proxy = options.proxy ?? createProxyAdapter(undefined, runner)
  const tcp = options.tcp ?? probeTcp
  const http = options.http ?? probeHttpProxy
  const directHttp = options.directHttp ?? probeDirectHttp
  const now = options.now ?? Date.now
  const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const repository = createNetworkRepository(options.configDir)
  const journalPath = path.join(options.configDir, 'network-apply-journal.json')
  const ownedRoutePath = path.join(options.configDir, 'network-owned-route.json')
  const plans = new Map<string, StoredPlan>()
  const bindingPlans = new Map<string, StoredBindingPlan>()
  const bindingBatchPlans = new Map<string, StoredBindingBatchPlan>()
  let busy = false

  async function resolveProfile(input: NetworkProfile): Promise<NetworkProfile> {
    const profile = profileInput(input)
    if (profile.proxyConfigPath || platform !== 'win32') return profile
    const detected = await discoverSakura(profile.proxyPort, runner)
    if (!detected.selected) return profile
    return { ...profile, proxyConfigPath: detected.selected.configPath,
      sakuraExecutable: detected.selected.clientExecutable || profile.sakuraExecutable }
  }

  async function observeBindings(destinations: string[]): Promise<BindingBatchObservation> {
    if (platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
    const targets = destinations.map(routeProbeAddress)
    const raw = await runner({ action: 'snapshot', targets, service: '', task: '', tunnel: '' }) as RawSnapshot
    if (!raw || !Array.isArray(raw.vpns) || !Array.isArray(raw.routes) || !Array.isArray(raw.selected)
      || !Array.isArray(raw.addresses) || !Array.isArray(raw.issues) || typeof raw.admin !== 'boolean') throw new Error('NETWORK_RESPONSE_INVALID')
    const selected = new Map<string, VpnRouteSelection>()
    for (const target of targets) {
      const route = raw.selected.find(item => item.target === target && item.source && item.interfaceAlias && item.prefix)
      if (route) selected.set(target, { target, source: route.source, interfaceAlias: route.interfaceAlias, prefix: route.prefix })
    }
    return { raw, selected, fingerprint: hash({ vpns: raw.vpns, routes: raw.routes, addresses: raw.addresses,
      selected: targets.map(target => selected.get(target) ?? null), admin: raw.admin,
      issues: raw.issues.filter(issue => /^(vpn\/|routes\/|selected\/|addresses)/.test(issue)) }) }
  }

  async function observeBinding(destination: string): Promise<BindingObservation> {
    const observed = await observeBindings([destination])
    return { raw: observed.raw, selected: observed.selected.get(routeProbeAddress(destination)) ?? null, fingerprint: observed.fingerprint }
  }

  function bindingPlan(input: VpnRouteTarget, observed: BindingObservation): VpnRoutePlan {
    const parsed = parseRoutePrefix(input.destination)
    if (!parsed || !input.vpnName || input.vpnName.length > 160 || /[\u0000-\u001f\u007f*?\[\]\\/]/.test(input.vpnName)
      || !['allUsers', 'currentUser'].includes(input.vpnScope)) throw new Error('VPN_ROUTE_DESTINATION_INVALID')
    const destination = parsed.prefix
    const vpn = observed.raw.vpns.find(item => item.name === input.vpnName && item.scope === input.vpnScope)
    const alreadyBound = !!vpn?.routes.some(route => route.prefix === destination)
    const issues: string[] = []
    if (observed.raw.issues.some(issue => /^(vpn\/|routes\/|selected\/|addresses)/.test(issue)) || !observed.selected) issues.push('VPN_ROUTE_INSPECTION_INCOMPLETE')
    if (!vpn) issues.push('VPN_ROUTE_VPN_MISSING')
    else {
      if (!vpn.connected) issues.push('VPN_ROUTE_VPN_DISCONNECTED')
      if (!vpn.splitTunneling) issues.push('VPN_ROUTE_SPLIT_REQUIRED')
    }
    if (input.vpnScope === 'allUsers' && !observed.raw.admin) issues.push('VPN_ROUTE_ELEVATION_REQUIRED')
    if (observed.raw.addresses.some(address => routePrefixContains(destination, address.IPAddress))) issues.push('VPN_ROUTE_LOCAL_ADDRESS')
    const conflicts = observed.raw.routes.filter(route => {
      const other = parseRoutePrefix(route.prefix)
      return other && other.bits >= parsed.bits && routePrefixOverlaps(destination, route.prefix)
        && route.interfaceAlias !== input.vpnName
    }).map(route => ({ prefix: route.prefix, interfaceAlias: route.interfaceAlias, store: route.store }))
    if (conflicts.length) issues.push('VPN_ROUTE_CONFLICT')
    if (alreadyBound) {
      if (observed.selected?.interfaceAlias === input.vpnName) issues.push('VPN_ROUTE_ALREADY_BOUND')
      else issues.push('VPN_ROUTE_NOT_SELECTED')
    }
    return { id: randomUUID(), destination, vpnName: input.vpnName, vpnScope: input.vpnScope,
      canApply: issues.length === 0, alreadyBound, expiresAt: new Date(now() + 120_000).toISOString(),
      issues, conflicts, selected: observed.selected }
  }

  function batchDestinations(input: VpnRouteBatchInput): string[] {
    if (!Array.isArray(input.destinations) || input.destinations.length < 1 || input.destinations.length > 32) throw new Error('VPN_ROUTE_BATCH_LIMIT')
    const prefixes = input.destinations.map(destination => {
      const parsed = typeof destination === 'string' ? parseRoutePrefix(destination) : null
      if (!parsed) throw new Error('VPN_ROUTE_DESTINATION_INVALID')
      return parsed.prefix
    })
    if (new Set(prefixes).size !== prefixes.length) throw new Error('VPN_ROUTE_BATCH_DUPLICATE')
    return prefixes
  }

  function buildBatchPlan(input: VpnRouteBatchInput, destinations: string[], observed: BindingBatchObservation): VpnRouteBatchPlan {
    const items = destinations.map(destination => bindingPlan({ destination, vpnName: input.vpnName, vpnScope: input.vpnScope }, {
      raw: observed.raw, selected: observed.selected.get(routeProbeAddress(destination)) ?? null, fingerprint: observed.fingerprint,
    }))
    const issues: string[] = []
    for (let left = 0; left < destinations.length; left++) {
      if (destinations.slice(left + 1).some(right => routePrefixOverlaps(destinations[left]!, right))) {
        issues.push('VPN_ROUTE_BATCH_OVERLAP')
        break
      }
    }
    const ready = items.every(item => item.canApply || (item.alreadyBound && item.issues.length === 1 && item.issues[0] === 'VPN_ROUTE_ALREADY_BOUND'))
    if (items.every(item => item.alreadyBound && item.issues.includes('VPN_ROUTE_ALREADY_BOUND'))) issues.push('VPN_ROUTE_BATCH_ALREADY_BOUND')
    return { id: randomUUID(), vpnName: input.vpnName, vpnScope: input.vpnScope,
      canApply: issues.length === 0 && ready, expiresAt: new Date(now() + 120_000).toISOString(), items, issues }
  }

  function vpnActiveInterface(raw: RawSnapshot, vpnName: string, vpnScope: string): number {
    const vpn = raw.vpns.find(item => item.name === vpnName && item.scope === vpnScope)
    if (!vpn?.connected || raw.vpns.some(item => item !== vpn && item.name === vpnName && item.connected)) throw new Error('VPN_ROUTE_INTERFACE_UNVERIFIED')
    const interfaces = raw.interfaces.filter(item => item.InterfaceAlias === vpnName
      && (item.ConnectionState === 1 || item.ConnectionState === 'Connected')
      && Number.isInteger(item.InterfaceIndex) && item.InterfaceIndex > 0)
    if (interfaces.length !== 1 || !raw.addresses.some(item => item.InterfaceIndex === interfaces[0]!.InterfaceIndex
      && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(item.IPAddress))) throw new Error('VPN_ROUTE_INTERFACE_UNVERIFIED')
    return interfaces[0]!.InterfaceIndex
  }

  function selectedVpn(observed: BindingObservation, destination: string, vpnName: string, vpnScope: string): boolean {
    const vpn = observed.raw.vpns.find(item => item.name === vpnName && item.scope === vpnScope)
    if (!vpn?.routes.some(route => route.prefix === destination) || observed.raw.issues.some(issue => /^(vpn\/|routes\/|selected\/|addresses)/.test(issue))) return false
    const selected = observed.raw.selected.find(item => item.target === routeProbeAddress(destination))
    return !!vpn.connected && !!selected && selected.interfaceAlias === vpnName
      && selected.interfaceIndex === vpnActiveInterface(observed.raw, vpnName, vpnScope)
  }

  async function activateBinding(change: BindingChange, vpnName: string, vpnScope: string): Promise<VpnRouteSelection> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const observed = await observeBinding(change.destination)
      if (selectedVpn(observed, change.destination, vpnName, vpnScope)) return observed.selected!
      if (attempt < 2) await delay(250)
    }
    const observed = await observeBinding(change.destination)
    if (!observed.raw.vpns.find(vpn => vpn.name === vpnName && vpn.scope === vpnScope)?.routes.some(route => route.prefix === change.destination)
      || observed.raw.issues.some(issue => /^(vpn\/|routes\/|selected\/|addresses)/.test(issue))) throw new Error('VPN_ROUTE_NOT_SELECTED')
    const interfaceIndex = vpnActiveInterface(observed.raw, vpnName, vpnScope)
    const parsed = parseRoutePrefix(change.destination)!
    if (observed.raw.routes.some(route => {
      const other = parseRoutePrefix(route.prefix)
      return other && other.bits >= parsed.bits && routePrefixOverlaps(route.prefix, change.destination)
        && route.interfaceIndex !== interfaceIndex
    })) throw new Error('VPN_ROUTE_CONFLICT')
    // An existing exact active route has another owner, even when its interface
    // is the VPN. Never replace or later remove it to win a metric tie.
    if (observed.raw.routes.some(route => route.store === 'ActiveStore' && route.prefix === change.destination)) throw new Error('VPN_ROUTE_NOT_SELECTED')
    const activeRoute: ActiveBindingRoute = { prefix: change.destination, interfaceIndex, nextHop: '0.0.0.0', metric: 1, store: 'ActiveStore' }
    change.activeAttempted = true
    await runner({ action: 'routeAdd', ...activeRoute })
    change.activeRoute = activeRoute
    for (let attempt = 0; attempt < 3; attempt++) {
      const after = await observeBinding(change.destination)
      if (selectedVpn(after, change.destination, vpnName, vpnScope)) return after.selected!
      if (attempt < 2) await delay(250)
    }
    throw new Error('VPN_ROUTE_NOT_SELECTED')
  }

  async function rollbackBinding(change: BindingChange, vpnName: string, vpnScope: string): Promise<'restored' | 'conflict'> {
    try {
      const observed = await observeBinding(change.destination)
      const exactActive = observed.raw.routes.filter(route => route.store === 'ActiveStore' && route.prefix === change.destination)
      if (change.activeAttempted && !change.activeRoute && exactActive.length) return 'conflict'
      if (change.activeRoute) {
        const active = exactActive.filter(route => route.interfaceIndex === change.activeRoute!.interfaceIndex
          && route.nextHop === change.activeRoute!.nextHop && route.metric === change.activeRoute!.metric)
        if (exactActive.length !== 1 || active.length !== 1) return 'conflict'
        if (vpnActiveInterface(observed.raw, vpnName, vpnScope) !== change.activeRoute.interfaceIndex) return 'conflict'
        await runner({ action: 'routeRemove', ...change.activeRoute })
        const afterActive = await observeBinding(change.destination)
        if (afterActive.raw.routes.some(route => route.store === 'ActiveStore' && route.prefix === change.destination
          && route.interfaceIndex === change.activeRoute!.interfaceIndex)) return 'conflict'
      }
      const after = await observeBinding(change.destination)
      const profileRoutes = after.raw.vpns.find(vpn => vpn.name === vpnName && vpn.scope === vpnScope)?.routes.filter(route => route.prefix === change.destination) ?? []
      if (change.profileAttempted && !change.profileAdded && profileRoutes.length) return 'conflict'
      if (change.profileAdded) {
        if (profileRoutes.length > 1 || (profileRoutes.length === 1 && profileRoutes[0]!.metric !== 1)) return 'conflict'
        if (profileRoutes.length) await runner({ action: 'vpnRouteRemove', name: vpnName, scope: vpnScope, prefix: change.destination })
        const restored = await observeBinding(change.destination)
        if (restored.raw.vpns.find(vpn => vpn.name === vpnName && vpn.scope === vpnScope)?.routes.some(route => route.prefix === change.destination)) return 'conflict'
      }
      return 'restored'
    } catch { return 'conflict' }
  }

  async function readJournal(): Promise<Journal | null> {
    try {
      if ((await fs.stat(journalPath)).size > 1_000_000) throw new Error('RECOVERY_JOURNAL_INVALID')
      const document = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Journal
      if (document.schemaVersion !== 1 || !Array.isArray(document.entries) || !['applying', 'applied', 'rolled-back', 'rollback-conflict'].includes(document.status)) throw new Error('RECOVERY_JOURNAL_INVALID')
      profileInput(document.profile)
      if (document.entries.length > 64) throw new Error('RECOVERY_JOURNAL_INVALID')
      document.entries.forEach(entry => validateJournalEntry(entry, document.profile))
      return document
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('RECOVERY_JOURNAL_INVALID')
    }
  }

  async function observe(profile: NetworkProfile): Promise<Observation> {
    let raw = emptyRaw()
    if (platform === 'win32') {
      raw = await runner({ action: 'snapshot', targets: [...new Set([profile.gatewayAddress, profile.containerProbeAddress, '1.1.1.1'])], service: serviceName(profile), task: profile.relayTaskName, tunnel: profile.tunnelName }) as RawSnapshot
      if (!raw || !Array.isArray(raw.interfaces) || !Array.isArray(raw.routes) || !Array.isArray(raw.vpns) || !Array.isArray(raw.selected)) throw new Error('NETWORK_RESPONSE_INVALID')
    }
    const vpn = raw.vpns.find(item => item.name === profile.vpnName && item.scope === profile.vpnScope)
    const issues = [...raw.issues]
    let proxyState: NetworkSnapshot['proxy'] = { available: false, mode: '', tunEnabled: false, controller: '', bypassPrefixes: [], configHash: '' }
    if (platform === 'win32') {
      try { proxyState = await proxy.inspect(profile) } catch (error) { issues.push(failure(error).ok ? '' : (failure(error) as { ok: false; error: { code: string } }).error.code) }
    } else issues.push('WINDOWS_REQUIRED')
    const journal = await readJournal()
    if (journal && ['applying', 'rollback-conflict'].includes(journal.status)) issues.push('RECOVERY_REQUIRED')
    const snapshot: NetworkSnapshot = {
      id: randomUUID(), collectedAt: new Date(now()).toISOString(), platform, elevated: raw.admin,
      interfaces: raw.interfaces.map(item => ({ index: item.InterfaceIndex, alias: item.InterfaceAlias, physical: raw.adapters.some(adapter => adapter.InterfaceIndex === item.InterfaceIndex), connected: item.ConnectionState === 1 || item.ConnectionState === 'Connected', metric: item.InterfaceMetric, addresses: raw.addresses.filter(address => address.InterfaceIndex === item.InterfaceIndex).map(address => `${address.IPAddress}/${address.PrefixLength}`) })),
      routes: raw.routes.map(route => ({ ...route, store: route.store === 'PersistentStore' ? 'persistent' : 'active' })),
      selectedRoutes: raw.selected.filter(route => route.source && route.interfaceIndex),
      vpn: { exists: !!vpn, connected: !!vpn?.connected, splitTunneling: !!vpn?.splitTunneling, routePrefixes: vpn?.routes.map(route => route.prefix) ?? [] },
      proxy: proxyState,
      tunnel: { serviceExists: !!raw.service, running: raw.service?.status === 'Running', taskExists: !!raw.task, taskRunning: raw.task?.state === 'Running', taskEnabled: !!raw.task?.enabled, latestHandshake: Math.max(0, ...raw.handshakes) || null },
      issues,
    }
    let ownedRoutes: Operation[] = []
    try {
      const owned = JSON.parse(await fs.readFile(ownedRoutePath, 'utf8'))
      const ownerProfile = profileInput(owned.profile)
      if (owned.schemaVersion !== 1 || !Array.isArray(owned.operations) || owned.operations.length > 2) throw new Error('ROUTE_OWNERSHIP_INVALID')
      for (const operation of owned.operations) {
        validateJournalEntry({ id: operation.id, operation, completed: true }, ownerProfile)
        if (operation.command.action !== 'routeAdd') throw new Error('ROUTE_OWNERSHIP_INVALID')
      }
      ownedRoutes = owned.operations
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') snapshot.issues.push('ROUTE_OWNERSHIP_INVALID')
    }
    return { snapshot, raw, ownedRoutes }
  }

  function buildPlan(profile: NetworkProfile, observation: Observation): StoredPlan {
    const { snapshot, raw } = observation
    const steps: NetworkStep[] = []
    const changes: NetworkChange[] = []
    const operations: Operation[] = []
    const step = (id: NetworkStep['id'], state: NetworkStep['state'], code: string, details: string[] = []) => steps.push({ id, state, code, details })
    const add = (id: NetworkChange['id'], before: string, after: string) => changes.push({ id, before, after })
    const op = (id: string, command: NetworkCommand, inverse: NetworkCommand, before: unknown, after: unknown) => operations.push({ id, command, inverse, before, after, ...(command.action.startsWith('route') ? { interfaceGuid: raw.adapters.find(item => item.InterfaceIndex === command.interfaceIndex)?.InterfaceGuid } : {}) })
    const physical = snapshot.interfaces.filter(item => item.physical && item.connected && item.addresses.length)
    if (platform !== 'win32') step('physical', 'blocked', 'windowsRequired')
    else step('physical', physical.length ? 'ready' : 'blocked', physical.length ? 'physicalReady' : 'physicalMissing', physical.map(item => `${item.alias}: ${item.addresses.join(', ')}`))
    if (snapshot.issues.includes('RECOVERY_REQUIRED')) step('physical', 'blocked', 'recoveryRequired', [journalPath])
    const selected = snapshot.selectedRoutes.find(route => route.target === profile.gatewayAddress)
    const selectedInterface = snapshot.interfaces.find(item => item.index === selected?.interfaceIndex)
    const viaVpn = selectedInterface?.alias === profile.vpnName
    if (profile.mode === 'home') {
      if (!snapshot.vpn.exists) step('vpn', 'manual', 'vpnMissing', [profile.vpnName, profile.vpnScope])
      else if (!snapshot.vpn.connected) step('vpn', 'manual', 'vpnNeedsConnection', [profile.vpnName, profile.vpnScope])
      else {
        const vpnArgs = { name: profile.vpnName, scope: profile.vpnScope }
        if (!snapshot.vpn.splitTunneling) {
          add('vpn-split', 'SplitTunneling=false', 'SplitTunneling=true')
          op('vpn-split', { action: 'split', ...vpnArgs, enabled: true }, { action: 'split', ...vpnArgs, enabled: false }, false, true)
        }
        if (!snapshot.vpn.routePrefixes.includes(profile.managementPrefix)) {
          add('vpn-route', '', profile.managementPrefix)
          op('vpn-route', { action: 'vpnRouteAdd', ...vpnArgs, prefix: profile.managementPrefix, metric: 1 }, { action: 'vpnRouteRemove', ...vpnArgs, prefix: profile.managementPrefix }, false, true)
        }
        step('vpn', changes.length ? 'change' : 'ready', changes.length ? 'vpnChange' : 'vpnReady', [profile.vpnName, profile.vpnScope])
      }
      const canCorrect = operations.some(item => item.id === 'vpn-route') && (!selected || Number(selected.prefix.split('/')[1]) <= Number(profile.managementPrefix.split('/')[1]))
      step('management', viaVpn ? 'ready' : canCorrect ? 'change' : 'blocked', viaVpn ? 'managementReady' : 'managementRouteMismatch', [selected ? `${selected.source} → ${selected.interfaceAlias} (${selected.prefix})` : profile.gatewayAddress])
    } else {
      step('vpn', 'skipped', 'workNoVpnRequired')
      const direct = selectedInterface?.physical && selectedInterface.connected && selected?.nextHop === '0.0.0.0'
      step('management', direct ? 'ready' : 'blocked', direct ? 'managementReady' : 'managementRouteMismatch', [selected ? `${selected.source} → ${selected.interfaceAlias} (${selected.prefix})` : profile.gatewayAddress])
    }
    const bypass = [profile.managementPrefix, ...(profile.containerEnabled ? [profile.containerPrefix] : [])]
    if (!snapshot.proxy.available) step('proxy', 'manual', 'proxyUnavailable', snapshot.issues.filter(issue => issue.startsWith('PROXY_')))
    else if (snapshot.proxy.mode !== 'rule' || bypass.some(prefix => !proxyBypassCovers(snapshot.proxy.bypassPrefixes, prefix))) {
      add('proxy-bypass', `${snapshot.proxy.mode}: ${snapshot.proxy.bypassPrefixes.join(', ')}`, `rule: ${bypass.join(', ')} DIRECT`)
      step('proxy', 'change', 'proxyChange', bypass)
    } else step('proxy', 'ready', 'proxyReady', bypass)

    if (!profile.containerEnabled) step('container', 'skipped', 'containerDisabled')
    else {
      const conflicts = snapshot.routes.filter(route => route.store === 'active' && Number(route.prefix.split('/')[1]) > Number(profile.containerPrefix.split('/')[1]) && isAddressInPrefix(route.prefix.split('/')[0] ?? '', profile.containerPrefix))
      if (conflicts.length) step('container', 'blocked', 'routeConflict', conflicts.map(route => `${route.prefix} → ${route.interfaceAlias} / ${route.nextHop}`))
      const overlaps = snapshot.interfaces.filter(item => item.alias !== profile.tunnelName && item.addresses.some(address => isAddressInPrefix(address.split('/')[0] ?? '', profile.containerPrefix)))
      if (overlaps.length) step('container', 'blocked', 'addressOverlap', overlaps.map(item => `${item.alias}: ${item.addresses.join(', ')}`))
      if (profile.mode === 'home') {
        const routes = snapshot.routes.filter(route => route.prefix === profile.containerPrefix && route.interfaceAlias !== profile.tunnelName)
        const owned = observation.ownedRoutes.filter(item => item.command.prefix === profile.containerPrefix && item.command.nextHop === profile.gatewayAddress)
        const matchesOwned = (route: NetworkSnapshot['routes'][number]) => owned.some(item => route.prefix === item.command.prefix && route.nextHop === item.command.nextHop && route.interfaceIndex === item.command.interfaceIndex && route.metric === item.command.metric && (route.store === 'active' ? 'ActiveStore' : 'PersistentStore') === item.command.store)
        if (routes.length) {
          if (owned.length && routes.every(matchesOwned)) {
            add('office-route', `${profile.containerPrefix} via ${profile.gatewayAddress}`, 'Remove the route previously created by this tool')
            for (const item of [...owned].sort((a, b) => String(a.command.store).localeCompare(String(b.command.store)))) {
              operations.push({ id: `office-route-remove-${item.command.store}`, command: { ...item.command, action: 'routeRemove' }, inverse: item.command, before: true, after: false, interfaceGuid: item.interfaceGuid })
            }
          } else step('container', 'blocked', 'routeConflict', routes.map(route => `${route.prefix} → ${route.interfaceAlias} / ${route.nextHop}; not owned by this tool`))
        }
        const vpnAddress = snapshot.interfaces.find(item => item.alias === profile.vpnName)?.addresses[0]?.split('/')[0]
        const actualSource = viaVpn ? selected?.source : vpnAddress
        if (!profile.expectedRelaySource || actualSource !== profile.expectedRelaySource) step('relay', 'blocked', 'sourceAclMismatch', [actualSource ?? 'unknown', profile.expectedRelaySource || 'not configured', 'Verify SSH_CONNECTION on the trusted gateway. Update both the exact INPUT source and relay -source; never allow all sources.'])
        else step('relay', snapshot.tunnel.taskRunning && snapshot.tunnel.taskEnabled ? 'ready' : 'change', snapshot.tunnel.taskRunning && snapshot.tunnel.taskEnabled ? 'relayReady' : 'relayChange', [`${profile.gatewayAddress}:${profile.relayPort}`, `Expected server-authorized source: ${profile.expectedRelaySource}; remote NAT/ACL is not automatically verified`])
        if (!snapshot.tunnel.taskExists) step('relay', 'manual', 'relayMissing', [profile.relayTaskName])
        else if (!snapshot.tunnel.taskRunning || !snapshot.tunnel.taskEnabled) {
          add('relay-start', `running=${snapshot.tunnel.taskRunning}, enabled=${snapshot.tunnel.taskEnabled}`, 'running=true, enabled=true')
          if (!snapshot.tunnel.taskEnabled) op('relay-enable', { action: 'taskEnabled', name: profile.relayTaskName, enabled: true }, { action: 'taskEnabled', name: profile.relayTaskName, enabled: false }, false, true)
          if (!snapshot.tunnel.taskRunning) op('relay-start', { action: 'task', name: profile.relayTaskName, running: true }, { action: 'task', name: profile.relayTaskName, running: false }, false, true)
        }
        if (!snapshot.tunnel.serviceExists) step('tunnel', 'manual', 'tunnelMissing', [serviceName(profile)])
        else {
          const startType = raw.service!.startType
          if (!snapshot.tunnel.running || startType !== 'Automatic') {
            add('tunnel-start', `running=${snapshot.tunnel.running}, startType=${startType}`, 'running=true, startType=Automatic')
            if (startType !== 'Automatic') op('tunnel-startup', { action: 'serviceStartup', name: serviceName(profile), startType: 'Automatic' }, { action: 'serviceStartup', name: serviceName(profile), startType }, startType, 'Automatic')
            if (!snapshot.tunnel.running) op('tunnel-start', { action: 'service', name: serviceName(profile), running: true }, { action: 'service', name: serviceName(profile), running: false }, false, true)
          }
          step('tunnel', snapshot.tunnel.running ? 'ready' : 'change', snapshot.tunnel.running ? 'tunnelReady' : 'tunnelChange', [profile.tunnelName])
        }
        step('container', 'ready', 'containerTunnel', [profile.containerPrefix])
      } else {
        // Stop and disable only this dedicated transport; corporate VPN and all other tunnels are preserved.
        if (snapshot.tunnel.serviceExists && (snapshot.tunnel.running || raw.service?.startType !== 'Manual')) {
          add('tunnel-stop', `running=${snapshot.tunnel.running}, startType=${raw.service?.startType}`, 'running=false, startType=Manual')
          if (snapshot.tunnel.running) op('tunnel-stop', { action: 'service', name: serviceName(profile), running: false }, { action: 'service', name: serviceName(profile), running: true }, true, false)
          if (raw.service?.startType !== 'Manual') op('tunnel-startup', { action: 'serviceStartup', name: serviceName(profile), startType: 'Manual' }, { action: 'serviceStartup', name: serviceName(profile), startType: raw.service!.startType }, raw.service!.startType, 'Manual')
        }
        if (snapshot.tunnel.taskExists && (snapshot.tunnel.taskRunning || snapshot.tunnel.taskEnabled)) {
          add('relay-stop', `running=${snapshot.tunnel.taskRunning}, enabled=${snapshot.tunnel.taskEnabled}`, 'running=false, enabled=false')
          if (snapshot.tunnel.taskRunning) op('relay-stop', { action: 'task', name: profile.relayTaskName, running: false }, { action: 'task', name: profile.relayTaskName, running: true }, true, false)
          if (snapshot.tunnel.taskEnabled) op('relay-disable', { action: 'taskEnabled', name: profile.relayTaskName, enabled: false }, { action: 'taskEnabled', name: profile.relayTaskName, enabled: true }, true, false)
        }
        const desired = { prefix: profile.containerPrefix, interfaceIndex: selected?.interfaceIndex, nextHop: profile.gatewayAddress, metric: 5, store: 'PersistentStore' }
        const existing = snapshot.routes.filter(route => route.prefix === profile.containerPrefix && route.interfaceAlias !== profile.tunnelName)
        const exact = existing.find(route => route.interfaceIndex === desired.interfaceIndex && route.nextHop === desired.nextHop && route.store === 'persistent')
        if (existing.some(route => route.interfaceIndex !== desired.interfaceIndex || route.nextHop !== desired.nextHop)) step('container', 'blocked', 'routeConflict', existing.map(route => `${route.prefix} → ${route.interfaceAlias} / ${route.nextHop}`))
        else if (selected && (!exact || !existing.some(route => route.store === 'active'))) {
          add('office-route', '', `${profile.containerPrefix} via ${profile.gatewayAddress} (${selected.interfaceAlias})`)
          // Add active first, then persistent. Their independently recorded inverses also
          // tolerate Windows versions that propagate a persistent route into ActiveStore.
          for (const store of ['ActiveStore', 'PersistentStore']) {
            if (existing.some(route => route.store === (store === 'ActiveStore' ? 'active' : 'persistent'))) continue
            op(`office-route-${store}`, { action: 'routeAdd', ...desired, store }, { action: 'routeRemove', ...desired, store }, false, true)
          }
        }
        step('container', exact ? 'ready' : 'change', 'containerDirect', [profile.containerPrefix, profile.gatewayAddress])
      }
    }
    if (operations.length && !snapshot.elevated) step('physical', 'manual', 'elevationRequired')
    const plan: NetworkPlan = { id: randomUUID(), profileId: profile.id, snapshotId: snapshot.id, createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 120_000).toISOString(), steps, changes, canApply: !steps.some(item => item.state === 'blocked' || item.state === 'manual') }
    plan.execution = operations.map(operation => ({ id: operation.id, command: { ...operation.command }, inverse: { ...operation.inverse } }))
    if (changes.some(change => change.id === 'proxy-bypass')) plan.execution.push({
      id: 'proxy-bypass', command: { action: 'proxy-bypass', configPath: profile.proxyConfigPath, mode: 'rule', prefixes: bypass }, inverse: null,
    })
    return { profile, observation, plan, fingerprint: stableSnapshot(observation), operations }
  }

  async function verify(profile: NetworkProfile): Promise<NetworkProbe[]> {
    let observation = await observe(profile)
    let snapshot = observation.snapshot
    const checks: NetworkProbe[] = []
    const routeCheck = (target: string, expectedAlias?: string, physical = false) => {
      const route = snapshot.selectedRoutes.find(item => item.target === target)
      const iface = snapshot.interfaces.find(item => item.index === route?.interfaceIndex)
      const gateway = snapshot.selectedRoutes.find(item => item.target === profile.gatewayAddress)
      const containerDirect = target !== profile.containerProbeAddress || (route?.nextHop === profile.gatewayAddress && route?.interfaceIndex === gateway?.interfaceIndex && route?.prefix === profile.containerPrefix)
      const ok = !!route && (physical ? !!iface?.physical && containerDirect : route.interfaceAlias === expectedAlias)
      checks.push({ target, kind: 'route', ok, checkedAt: new Date(now()).toISOString(), latencyMs: 0, source: route?.source, interfaceAlias: route?.interfaceAlias, detail: ok ? 'EXPECTED_ROUTE_SELECTED' : 'ROUTE_MISMATCH' })
    }
    routeCheck(profile.gatewayAddress, profile.vpnName, profile.mode === 'work')
    checks.push(await tcp(profile.gatewayAddress, profile.gatewayPort))
    const external = await http(profile.externalProbeUrl, profile.proxyPort)
    const desiredBypass = [profile.managementPrefix, ...(profile.containerEnabled ? [profile.containerPrefix] : [])]
    if (!snapshot.proxy.available || snapshot.proxy.mode !== 'rule' || desiredBypass.some(prefix => !proxyBypassCovers(snapshot.proxy.bypassPrefixes, prefix))) {
      external.ok = false
      external.detail = 'PROXY_CONFIGURATION_MISMATCH'
    }
    checks.push(external)
    if (profile.containerEnabled) {
      // Generate real tunnel traffic before sampling handshake; a newly started peer may be idle.
      const containerProbe = await tcp(profile.containerProbeAddress, profile.containerProbePort)
      if (profile.mode === 'home') {
        checks.push(await tcp(profile.gatewayAddress, profile.relayPort))
        for (let attempt = 0; attempt < 4; attempt++) {
          observation = await observe(profile)
          snapshot = observation.snapshot
          if (snapshot.tunnel.latestHandshake && now() / 1000 - snapshot.tunnel.latestHandshake < 180) break
          if (attempt < 3) await delay(1000)
        }
        checks.push({ target: profile.tunnelName, kind: 'handshake', ok: !!snapshot.tunnel.latestHandshake && now() / 1000 - snapshot.tunnel.latestHandshake < 180, checkedAt: new Date(now()).toISOString(), latencyMs: 0, detail: snapshot.tunnel.latestHandshake ? 'WIREGUARD_HANDSHAKE_AGE_CHECKED' : 'WIREGUARD_NO_HANDSHAKE' })
      }
      routeCheck(profile.containerProbeAddress, profile.tunnelName, profile.mode === 'work')
      checks.push(containerProbe.ok ? containerProbe : await tcp(profile.containerProbeAddress, profile.containerProbePort))
    }
    return checks
  }

  function currentValue(operation: Operation, observation: Observation): unknown {
    const { snapshot, raw } = observation
    const command = operation.command
    if (command.action === 'split') return snapshot.vpn.splitTunneling
    if (command.action === 'vpnRouteAdd' || command.action === 'vpnRouteRemove') {
      const routes = raw.vpns.find(vpn => vpn.name === command.name && vpn.scope === command.scope)?.routes.filter(route => route.prefix === command.prefix) ?? []
      return !routes.length ? false : routes.length === 1 && routes[0]!.metric === 1 ? true : 'CONFLICT'
    }
    if (command.action === 'service') return snapshot.tunnel.running
    if (command.action === 'serviceStartup') return raw.service?.startType
    if (command.action === 'task') return snapshot.tunnel.taskRunning
    if (command.action === 'taskEnabled') return snapshot.tunnel.taskEnabled
    if (command.action === 'routeAdd' || command.action === 'routeRemove') {
      if (!operation.interfaceGuid || !raw.adapters.some(adapter => adapter.InterfaceIndex === command.interfaceIndex && adapter.InterfaceGuid === operation.interfaceGuid)) return 'CONFLICT'
      const routes = raw.routes.filter(route => route.prefix === command.prefix && route.interfaceIndex === command.interfaceIndex && route.nextHop === command.nextHop && route.store === command.store)
      return !routes.length ? false : routes.length === 1 && routes[0]!.metric === command.metric ? true : 'CONFLICT'
    }
    throw new Error('RECOVERY_JOURNAL_INVALID')
  }

  async function rollback(journal: Journal, report: NetworkApplyReport): Promise<void> {
    for (const entry of [...journal.entries].reverse()) {
      if (entry.restored) continue
      try {
        let restored = true
        if (entry.proxy) restored = await proxy.rollback(journal.profile, entry.proxy)
        else if (entry.operation) {
          const current = currentValue(entry.operation, await observe(journal.profile))
          if (JSON.stringify(current) === JSON.stringify(entry.operation.after)) await runner(entry.operation.inverse)
          else if (JSON.stringify(current) !== JSON.stringify(entry.operation.before)) restored = false
        }
        report.rollback.push(`${entry.id}: ${restored ? 'RESTORED' : 'CONFLICT_PRESERVED'}`)
        entry.restored = restored
        await writePrivateJson(journalPath, journal)
        if (!restored) report.status = 'rollback-conflict'
      } catch { report.rollback.push(`${entry.id}: RESTORE_FAILED`); report.status = 'rollback-conflict' }
    }
    journal.status = report.status === 'rollback-conflict' ? 'rollback-conflict' : 'rolled-back'
    report.status = journal.status
    await writePrivateJson(journalPath, journal)
  }

  return {
    list: () => safe(() => repository.read()),
    discoverProxy: proxyPort => safe(async () => {
      if (platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
      return discoverSakura(proxyPort, runner)
    }),
    executionCatalog: () => safe(async () => getNetworkExecutionCatalog()),
    save: (profile, revision) => safe(async () => {
      if (busy) throw new Error('NETWORK_BUSY')
      const saved = await repository.save(profileInput(profile), revision)
      for (const [id, item] of plans) if (item.profile.id === profile.id) plans.delete(id)
      return saved
    }),
    inspect: profile => safe(async () => (await observe(await resolveProfile(profile))).snapshot),
    plan: profile => safe(async () => {
      const parsed = await resolveProfile(profile)
      const observation = await observe(parsed)
      const stored = buildPlan(parsed, observation)
      for (const [id, item] of plans) if (Date.parse(item.plan.expiresAt) < now() || item.profile.id === parsed.id) plans.delete(id)
      if (plans.size > 32) plans.delete(plans.keys().next().value!)
      plans.set(stored.plan.id, stored)
      return { snapshot: observation.snapshot, plan: structuredClone(stored.plan) }
    }),
    apply: planId => safe(async () => {
      if (busy) throw new Error('NETWORK_BUSY')
      busy = true
      try {
        const stored = plans.get(planId)
        if (!stored || Date.parse(stored.plan.expiresAt) < now()) throw new Error('PLAN_EXPIRED')
        if (!stored.plan.canApply) throw new Error('PLAN_BLOCKED')
        const fresh = await observe(stored.profile)
        if (stableSnapshot(fresh) !== stored.fingerprint || fresh.snapshot.issues.includes('RECOVERY_REQUIRED')) throw new Error('PLAN_STALE')
        plans.delete(planId)
        const journal: Journal = { schemaVersion: 1, planId, profile: stored.profile, status: 'applying', entries: [] }
        const report: NetworkApplyReport = { planId, status: 'failed', completedChanges: [], rollback: [], probes: [], issues: [] }
        await writePrivateJson(journalPath, journal)
        try {
          // The management path must respond before disrupting the dedicated container transport.
          const management = await tcp(stored.profile.gatewayAddress, stored.profile.gatewayPort)
          if (!management.ok && !stored.operations.some(item => item.id === 'vpn-route')) throw new Error('MANAGEMENT_UNREACHABLE')
          for (const operation of stored.operations) {
            if (operation.id === 'relay-start' || operation.id === 'tunnel-start') {
              const managementRoute = (await observe(stored.profile)).snapshot.selectedRoutes.find(route => route.target === stored.profile.gatewayAddress)
              if (managementRoute?.interfaceAlias !== stored.profile.vpnName || managementRoute.source !== stored.profile.expectedRelaySource) throw new Error('SOURCE_ACL_MISMATCH')
              if (!(await tcp(stored.profile.gatewayAddress, stored.profile.gatewayPort)).ok) throw new Error('MANAGEMENT_UNREACHABLE')
              const outer = await tcp(stored.profile.gatewayAddress, stored.profile.relayPort)
              if (!outer.ok) throw new Error('RELAY_UNREACHABLE_CHECK_SOURCE_ACL')
            }
            const current = currentValue(operation, await observe(stored.profile))
            if (operation.command.action.startsWith('route') && JSON.stringify(current) === JSON.stringify(operation.after)) continue
            if (JSON.stringify(current) !== JSON.stringify(operation.before)) throw new Error('FIELD_CHANGED')
            const entry: JournalEntry = { id: operation.id, operation, completed: false }
            journal.entries.push(entry)
            await writePrivateJson(journalPath, journal)
            await runner(operation.command)
            let verified = false
            for (let attempt = 0; attempt < 3; attempt++) {
              if (JSON.stringify(currentValue(operation, await observe(stored.profile))) === JSON.stringify(operation.after)) { verified = true; break }
              if (attempt < 2) await delay(250)
            }
            if (!verified) throw new Error('CHANGE_NOT_APPLIED')
            entry.completed = true
            report.completedChanges.push(operation.id)
            await writePrivateJson(journalPath, journal)
          }
          if (stored.plan.changes.some(change => change.id === 'proxy-bypass')) {
            await proxy.apply(stored.profile, stored.observation.snapshot.proxy.configHash, async undo => {
              journal.entries.push({ id: 'proxy-bypass', proxy: undo, completed: false })
              await writePrivateJson(journalPath, journal)
            })
            journal.entries[journal.entries.length - 1]!.completed = true
            report.completedChanges.push('proxy-bypass')
            await writePrivateJson(journalPath, journal)
          }
          report.probes = await verify(stored.profile)
          if (report.probes.some(probe => !probe.ok)) throw new Error('VERIFICATION_FAILED')
          report.status = 'applied'
          const owned = journal.entries.flatMap(entry => entry.completed && entry.operation?.command.action === 'routeAdd' ? [entry.operation] : [])
          if (owned.length) await writePrivateJson(ownedRoutePath, { schemaVersion: 1, profile: stored.profile, operations: owned })
          if (stored.operations.some(operation => operation.id.startsWith('office-route-remove-'))) await fs.rm(ownedRoutePath, { force: true })
          journal.status = 'applied'
          await writePrivateJson(journalPath, journal)
        } catch (error) {
          const result = failure(error)
          report.issues.push(result.ok ? 'NETWORK_OPERATION_FAILED' : result.error.code)
          await rollback(journal, report)
        }
        return report
      } finally { busy = false }
    }),
    verify: profile => safe(async () => {
      if (platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
      return verify(await resolveProfile(profile))
    }),
    probeHost: hostId => safe(async () => {
      if (!/^[0-9a-f-]{36}$/i.test(hostId)) throw new Error('INVALID_HOST_ID')
      const host = await options.resolveHost(hostId)
      if (!host) throw new Error('HOST_NOT_FOUND')
      return { ...await tcp(host.address, host.port), hostId }
    }),
    openNetworkConnections: () => safe(async () => {
      if (platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
      const windowsDir = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR || 'C:\\Windows'
      if (!/^[a-z]:[\\/]/i.test(windowsDir)) throw new Error('NETWORK_CONNECTIONS_OPEN_FAILED')
      // ShellExecute the fixed system applet through Electron shell.openPath.
      // No cmd/PowerShell process, renderer-supplied path, profile, or write plan.
      const applet = path.win32.join(windowsDir, 'System32', 'ncpa.cpl')
      try {
        const error = await options.openPath(applet)
        if (error) throw new Error('NETWORK_CONNECTIONS_OPEN_FAILED')
      } catch {
        throw new Error('NETWORK_CONNECTIONS_OPEN_FAILED')
      }
      return null
    }),
    login: (target, input) => safe(async () => {
      if (platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
      const profile = profileInput(input)
      if (target === 'vpn') await options.openExternal('ms-settings:network-vpn')
      else {
        // Do not start a second client or try to launch a core without its arguments.
        if ((await discoverSakura(profile.proxyPort, runner)).running) return null
        if (!profile.sakuraExecutable) throw new Error('SAKURA_EXECUTABLE_REQUIRED')
        const result = await options.openPath(profile.sakuraExecutable)
        if (result) throw new Error('SAKURA_LAUNCH_FAILED')
      }
      return null
    }),
    vpnRouteOptions: () => safe(async () => {
      const observed = await observeBinding('1.1.1.1/32')
      if (observed.raw.issues.some(issue => issue.startsWith('vpn/'))) throw new Error('VPN_ROUTE_INSPECTION_INCOMPLETE')
      return { vpns: observed.raw.vpns.map(vpn => ({ name: vpn.name, scope: vpn.scope as 'allUsers' | 'currentUser', connected: vpn.connected, splitTunneling: vpn.splitTunneling, routes: vpn.routes })) }
    }),
    vpnRoutePreview: input => safe(async () => {
      const parsed = parseRoutePrefix(input.destination)
      if (!parsed) throw new Error('VPN_ROUTE_DESTINATION_INVALID')
      const observed = await observeBinding(parsed.prefix)
      const plan = bindingPlan(input, observed)
      for (const [id, stored] of bindingPlans) if (Date.parse(stored.plan.expiresAt) < now()) bindingPlans.delete(id)
      if (bindingPlans.size > 32) bindingPlans.delete(bindingPlans.keys().next().value!)
      bindingPlans.set(plan.id, { plan, fingerprint: observed.fingerprint })
      return plan
    }),
    vpnRouteVerify: input => safe(async () => {
      const parsed = parseRoutePrefix(input.destination)
      if (!parsed) throw new Error('VPN_ROUTE_DESTINATION_INVALID')
      return bindingPlan(input, await observeBinding(parsed.prefix))
    }),
    vpnRouteBatchPreview: input => safe(async () => {
      const destinations = batchDestinations(input)
      const observed = await observeBindings(destinations)
      const plan = buildBatchPlan(input, destinations, observed)
      for (const [id, stored] of bindingBatchPlans) if (Date.parse(stored.plan.expiresAt) < now()) bindingBatchPlans.delete(id)
      if (bindingBatchPlans.size > 32) bindingBatchPlans.delete(bindingBatchPlans.keys().next().value!)
      bindingBatchPlans.set(plan.id, { plan, fingerprint: observed.fingerprint })
      return plan
    }),
    vpnRouteBatchVerify: input => safe(async () => {
      const destinations = batchDestinations(input)
      return buildBatchPlan(input, destinations, await observeBindings(destinations))
    }),
    vpnRouteBatchApply: planId => safe(async () => {
      if (busy) throw new Error('NETWORK_BUSY')
      busy = true
      try {
        const stored = bindingBatchPlans.get(planId)
        if (!stored || Date.parse(stored.plan.expiresAt) < now()) throw new Error('PLAN_EXPIRED')
        if (!stored.plan.canApply) throw new Error('PLAN_BLOCKED')
        const { vpnName, vpnScope } = stored.plan
        const destinations = stored.plan.items.map(item => item.destination)
        const fresh = await observeBindings(destinations)
        if (fresh.fingerprint !== stored.fingerprint) throw new Error('PLAN_STALE')
        const checked = buildBatchPlan({ destinations, vpnName, vpnScope }, destinations, fresh)
        if (!checked.canApply) throw new Error('PLAN_STALE')
        bindingBatchPlans.delete(planId)
        const report: VpnRouteBatchReport = { status: 'rolled-back', destinations, selected: [], issues: [] }
        const added: BindingChange[] = []
        try {
          for (const item of checked.items) {
            if (item.alreadyBound) continue
            const current = await observeBinding(item.destination)
            if (!bindingPlan(item, current).canApply) throw new Error('PLAN_STALE')
            const change: BindingChange = { destination: item.destination, profileAttempted: false, profileAdded: false, activeAttempted: false, activeRoute: null }
            added.push(change)
            change.profileAttempted = true
            await runner({ action: 'vpnRouteAdd', name: vpnName, scope: vpnScope, prefix: item.destination, metric: 1 })
            change.profileAdded = true
            await activateBinding(change, vpnName, vpnScope)
          }
          const after = await observeBindings(destinations)
          if (destinations.some(destination => !selectedVpn({
            raw: after.raw, selected: after.selected.get(routeProbeAddress(destination)) ?? null, fingerprint: after.fingerprint,
          }, destination, vpnName, vpnScope))) throw new Error('VPN_ROUTE_NOT_SELECTED')
          report.status = 'applied'
          report.selected = [...after.selected.values()]
          return report
        } catch (error) {
          const result = failure(error)
          report.issues.push(result.ok ? 'NETWORK_OPERATION_FAILED' : result.error.code)
          for (const change of [...added].reverse()) {
            if (await rollbackBinding(change, vpnName, vpnScope) === 'conflict') {
              report.status = 'rollback-conflict'
              report.issues.push(change.profileAttempted && !change.profileAdded || change.activeAttempted && !change.activeRoute
                ? 'VPN_ROUTE_OWNERSHIP_UNCERTAIN' : 'VPN_ROUTE_ROLLBACK_FAILED')
            }
          }
          try { report.selected = [...(await observeBindings(destinations)).selected.values()] }
          catch { report.status = 'rollback-conflict'; report.issues.push('VPN_ROUTE_INSPECTION_INCOMPLETE') }
          return report
        }
      } finally { busy = false }
    }),
    vpnRouteProbe: input => safe(async () => {
      const parsed = typeof input.address === 'string' ? parseRoutePrefix(input.address) : null
      if (!parsed || parsed.bits !== 32 || input.address !== parsed.prefix.slice(0, -3)
        || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535
        || !['tcp', 'http', 'https'].includes(input.protocol)) throw new Error('VPN_ROUTE_PROBE_INVALID')
      const observed = await observeBinding(parsed.prefix)
      const vpn = observed.raw.vpns.find(item => item.name === input.vpnName && item.scope === input.vpnScope)
      const issues: string[] = []
      if (!vpn) issues.push('VPN_ROUTE_VPN_MISSING')
      else if (!vpn.connected) issues.push('VPN_ROUTE_VPN_DISCONNECTED')
      if (!observed.selected || observed.raw.issues.some(issue => /^(vpn\/|routes\/|selected\/)/.test(issue))) issues.push('VPN_ROUTE_INSPECTION_INCOMPLETE')
      const viaVpn = !!vpn?.connected && observed.selected?.interfaceAlias === input.vpnName
      if (!viaVpn) issues.push('VPN_ROUTE_NOT_SELECTED')
      if (!viaVpn) return { selected: observed.selected, viaVpn, probe: null, issues }
      const probe = input.protocol === 'tcp' ? await tcp(input.address, input.port) : await directHttp(input.address, input.port, input.protocol)
      if (!probe.ok) issues.push('VPN_ROUTE_TARGET_UNREACHABLE')
      return { selected: observed.selected, viaVpn, probe: { ...probe, source: probe.source ?? observed.selected?.source, interfaceAlias: observed.selected?.interfaceAlias }, issues }
    }),
    vpnRouteApply: planId => safe(async () => {
      if (busy) throw new Error('NETWORK_BUSY')
      busy = true
      try {
        const stored = bindingPlans.get(planId)
        if (!stored || Date.parse(stored.plan.expiresAt) < now()) throw new Error('PLAN_EXPIRED')
        if (!stored.plan.canApply) throw new Error('PLAN_BLOCKED')
        const { destination, vpnName, vpnScope } = stored.plan
        const fresh = await observeBinding(destination)
        if (fresh.fingerprint !== stored.fingerprint) throw new Error('PLAN_STALE')
        const checked = bindingPlan({ destination, vpnName, vpnScope }, fresh)
        if (!checked.canApply) throw new Error('PLAN_STALE')
        bindingPlans.delete(planId)
        const report: VpnRouteApplyReport = { status: 'rolled-back', destination, selected: fresh.selected, issues: [] }
        const change: BindingChange = { destination, profileAttempted: false, profileAdded: false, activeAttempted: false, activeRoute: null }
        try {
          change.profileAttempted = true
          await runner({ action: 'vpnRouteAdd', name: vpnName, scope: vpnScope, prefix: destination, metric: 1 })
          change.profileAdded = true
          const selected = await activateBinding(change, vpnName, vpnScope)
          report.status = 'applied'
          report.selected = selected
          return report
        } catch (error) {
          const result = failure(error)
          report.issues.push(result.ok ? 'NETWORK_OPERATION_FAILED' : result.error.code)
          if (await rollbackBinding(change, vpnName, vpnScope) === 'conflict') {
            report.status = 'rollback-conflict'
            report.issues.push(change.profileAttempted && !change.profileAdded || change.activeAttempted && !change.activeRoute
              ? 'VPN_ROUTE_OWNERSHIP_UNCERTAIN' : 'VPN_ROUTE_ROLLBACK_FAILED')
          }
          try { report.selected = (await observeBinding(destination)).selected }
          catch { report.status = 'rollback-conflict'; report.issues.push('VPN_ROUTE_INSPECTION_INCOMPLETE') }
          return report
        }
      } finally { busy = false }
    }),
    recover: () => safe(async () => {
      if (platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
      if (busy) throw new Error('NETWORK_BUSY')
      busy = true
      try {
        const journal = await readJournal()
        if (!journal || !['applying', 'rollback-conflict'].includes(journal.status)) throw new Error('NO_PENDING_RECOVERY')
        const report: NetworkApplyReport = { planId: journal.planId, status: 'rolled-back', completedChanges: journal.entries.filter(entry => entry.completed).map(entry => entry.id), rollback: [], probes: [], issues: [] }
        await rollback(journal, report)
        return report
      } finally { busy = false }
    }),
  }
}
