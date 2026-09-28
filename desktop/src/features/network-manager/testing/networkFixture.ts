import type { SakuraDiscovery } from '../networkTypes'
import { createDefaultNetworkProfiles, type NetworkManagerApi, type NetworkPlan, type NetworkProbe, type NetworkProfilesDocument, type NetworkSnapshot, type VpnRouteBatchPlan, type VpnRoutePlan } from '../networkTypes'

export function createNetworkFixture() {
  let document: NetworkProfilesDocument = { schemaVersion: 1, revision: 1, profiles: createDefaultNetworkProfiles() }
  const calls: Array<{ action: string; input?: unknown }> = []
  const snapshot: NetworkSnapshot = {
    id: 'fixture-snapshot', collectedAt: '2026-09-25T02:00:00.000Z', platform: 'win32', elevated: true,
    interfaces: [{ index: 7, alias: 'Fixture Ethernet', physical: true, connected: true, addresses: ['191.168.7.10'], metric: 10 }],
    routes: [], selectedRoutes: [{ target: '191.168.7.62', source: '191.168.7.10', interfaceIndex: 7, interfaceAlias: 'Fixture Ethernet', prefix: '191.168.0.0/16', nextHop: '0.0.0.0' }],
    vpn: { exists: true, connected: true, splitTunneling: false, routePrefixes: [] },
    proxy: { available: true, mode: 'rule', tunEnabled: false, controller: '127.0.0.1:9090', bypassPrefixes: [], configHash: 'fixture-hash' },
    tunnel: { serviceExists: true, running: true, taskExists: true, taskRunning: true, taskEnabled: true, latestHandshake: 1 }, issues: [],
  }
  const plan: NetworkPlan = {
    id: 'fixture-plan', profileId: 'home', snapshotId: snapshot.id, createdAt: snapshot.collectedAt, expiresAt: '2099-01-01T00:00:00.000Z', canApply: true,
    steps: [{ id: 'vpn', state: 'change', code: 'vpnChange', details: ['191.168.0.0/16'] }],
    changes: [{ id: 'vpn-split', before: 'false', after: 'true' }],
  }
  const probe: NetworkProbe = { target: 'fixture.invalid', port: 22, kind: 'tcp', ok: true, checkedAt: snapshot.collectedAt, latencyMs: 4, detail: 'Fixture TCP connected', hostId: 'fixture-host', source: '191.168.7.10', interfaceAlias: 'Fixture Ethernet' }
  const vpnRoutePlan: VpnRoutePlan = {
    id: '11111111-1111-4111-8111-111111111111', destination: '10.204.19.81/32', vpnName: '124.114.142.77', vpnScope: 'allUsers',
    canApply: true, alreadyBound: false, expiresAt: '2099-01-01T00:00:00.000Z', issues: [], conflicts: [],
    selected: { target: '10.204.19.81', source: '162.168.1.2', interfaceAlias: 'Fixture VPN', prefix: '10.204.19.81/32' },
  }
  const vpnRouteBatchPlan: VpnRouteBatchPlan = {
    id: '22222222-2222-4222-8222-222222222222',
    vpnName: vpnRoutePlan.vpnName,
    vpnScope: vpnRoutePlan.vpnScope,
    canApply: true,
    expiresAt: vpnRoutePlan.expiresAt,
    items: [vpnRoutePlan],
    issues: [],
  }
  let latestBatchPlan = vpnRouteBatchPlan
  let batchApplied = false
  const batchSelection = (destination: string) => ({
    target: destination.split('/')[0]!, source: batchApplied ? '162.168.1.2' : '192.168.3.93',
    interfaceAlias: batchApplied ? vpnRoutePlan.vpnName : 'WLAN',
    prefix: batchApplied ? (destination.includes('/') ? destination : `${destination}/32`) : '0.0.0.0/0',
  })
  const discovery: SakuraDiscovery = { status: 'not-running', running: false, checkedAt: snapshot.collectedAt, proxyPort: 7897, selected: null, candidates: [], issues: [] }
  const api: NetworkManagerApi = {
    async discoverProxy(proxyPort) { calls.push({ action: 'discoverProxy', input: proxyPort }); return { ok: true, data: { ...structuredClone(discovery), proxyPort } } },
    async executionCatalog() { calls.push({ action: 'executionCatalog' }); return { ok: true, data: { executor: 'Isolated fixture executor', actions: [{ id: 'snapshot', kind: 'read', source: 'fixture/powershell.ts', functionName: 'runNetworkPowerShell', script: 'Get-NetIPInterface # fixture only' }, { id: 'proxyDiscover', kind: 'read', source: 'fixture/powershell.ts', functionName: 'Get-SakuraProcesses', script: 'Get-CimInstance Win32_Process # fixture only' }] } } },
    async openNetworkConnections() { calls.push({ action: 'openNetworkConnections' }); return { ok: true, data: null } },
    async list() { calls.push({ action: 'list' }); return { ok: true, data: structuredClone(document) } },
    async save(profile, expectedRevision) {
      calls.push({ action: 'save', input: { profile, expectedRevision } })
      if (expectedRevision !== document.revision) return { ok: false, error: { code: 'REVISION_CONFLICT', message: 'Fixture revision changed' } }
      document = { ...document, revision: document.revision + 1, profiles: [...document.profiles.filter(item => item.id !== profile.id), structuredClone(profile)] }
      return { ok: true, data: structuredClone(document) }
    },
    async inspect(profile) { calls.push({ action: 'inspect', input: profile }); return { ok: true, data: structuredClone(snapshot) } },
    async plan(profile) { calls.push({ action: 'plan', input: profile }); return { ok: true, data: { snapshot: structuredClone(snapshot), plan: { ...structuredClone(plan), profileId: profile.id } } } },
    async apply(planId) { calls.push({ action: 'apply', input: planId }); return { ok: true, data: { planId, status: 'applied', completedChanges: ['vpn-split'], rollback: [], probes: [], issues: [] } } },
    async verify(profile) { calls.push({ action: 'verify', input: profile }); return { ok: true, data: [structuredClone(probe)] } },
    async probeHost(hostId) { calls.push({ action: 'probeHost', input: hostId }); return { ok: true, data: { ...structuredClone(probe), hostId } } },
    async login(target, profile) { calls.push({ action: 'login', input: { target, profile } }); return { ok: true, data: null } },
    async recover() { calls.push({ action: 'recover' }); return { ok: true, data: { planId: plan.id, status: 'rolled-back', completedChanges: [], rollback: ['vpn-split restored'], probes: [], issues: [] } } },
    async vpnRouteOptions() {
      calls.push({ action: 'vpnRouteOptions' })
      return { ok: true, data: { vpns: [{ name: '124.114.142.77', scope: 'allUsers', connected: true, splitTunneling: true, routes: [] }] } }
    },
    async vpnRoutePreview(target) { calls.push({ action: 'vpnRoutePreview', input: target }); return { ok: true, data: { ...vpnRoutePlan, ...target } } },
    async vpnRouteApply(planId) {
      calls.push({ action: 'vpnRouteApply', input: planId })
      return { ok: true, data: { status: 'applied', destination: vpnRoutePlan.destination, selected: vpnRoutePlan.selected, issues: [] } }
    },
    async vpnRouteVerify(target) { calls.push({ action: 'vpnRouteVerify', input: target }); return { ok: true, data: { ...vpnRoutePlan, ...target, canApply: false, alreadyBound: true } } },
    async vpnRouteBatchPreview(input) {
      calls.push({ action: 'vpnRouteBatchPreview', input })
      latestBatchPlan = {
        ...vpnRouteBatchPlan, vpnName: input.vpnName, vpnScope: input.vpnScope,
        items: input.destinations.map(destination => ({ ...vpnRoutePlan, destination, vpnName: input.vpnName, vpnScope: input.vpnScope, selected: batchSelection(destination) })),
      }
      return { ok: true, data: latestBatchPlan }
    },
    async vpnRouteBatchApply(planId) {
      calls.push({ action: 'vpnRouteBatchApply', input: planId })
      batchApplied = true
      return { ok: true, data: {
        status: 'applied', destinations: latestBatchPlan.items.map(item => item.destination),
        selected: latestBatchPlan.items.map(item => batchSelection(item.destination)), issues: [],
      } }
    },
    async vpnRouteBatchVerify(input) {
      calls.push({ action: 'vpnRouteBatchVerify', input })
      return { ok: true, data: {
        ...vpnRouteBatchPlan, vpnName: input.vpnName, vpnScope: input.vpnScope, canApply: false,
        items: input.destinations.map(destination => ({ ...vpnRoutePlan, destination, vpnName: input.vpnName, vpnScope: input.vpnScope,
          selected: batchSelection(destination), canApply: !batchApplied, alreadyBound: batchApplied })),
      } }
    },
    async vpnRouteProbe(input) {
      calls.push({ action: 'vpnRouteProbe', input })
      return { ok: true, data: {
        selected: { ...vpnRoutePlan.selected!, target: input.address },
        viaVpn: true,
        probe: { ...probe, target: input.address, port: input.port, kind: 'tcp', statusCode: input.protocol === 'tcp' ? undefined : 200 },
        issues: [],
      } }
    },
  }
  return { api, calls, snapshot, plan, probe, discovery, vpnRoutePlan, vpnRouteBatchPlan }
}
