/** Desired configuration is kept separate from observed state and verification evidence. */
export type NetworkProfile = {
  id: string
  name: string
  mode: 'home' | 'work'
  vpnName: string
  vpnScope: 'allUsers' | 'currentUser'
  managementPrefix: string
  gatewayAddress: string
  gatewayPort: number
  proxyConfigPath: string
  sakuraExecutable: string
  proxyPort: number
  externalProbeUrl: string
  containerEnabled: boolean
  containerPrefix: string
  containerProbeAddress: string
  containerProbePort: number
  tunnelName: string
  relayTaskName: string
  relayPort: number
  /** Expected outer source already authorized at the server; never an ACL wildcard. */
  expectedRelaySource: string
}

export type SakuraInstance = {
  pid: number
  startedAt: string
  executablePath: string
  clientExecutable: string
  configPath: string
  controller: string
  listeningPorts: number[]
  configSource: 'process-argument' | 'unresolved'
}
export type SakuraDiscovery = {
  status: 'detected' | 'not-running' | 'ambiguous' | 'incomplete'
  running: boolean
  checkedAt: string
  proxyPort: number
  selected: SakuraInstance | null
  candidates: SakuraInstance[]
  issues: string[]
}
export type NetworkExecutionAction = {
  id: string
  kind: 'read' | 'probe' | 'write' | 'launch' | 'save'
  source: string
  functionName: string
  script: string
}
export type NetworkExecutionCatalog = { actions: NetworkExecutionAction[]; executor: string }
export type NetworkPlanExecution = {
  id: string
  command: Record<string, unknown>
  inverse: Record<string, unknown> | null
}

export type NetworkProfilesDocument = { schemaVersion: 1; revision: number; profiles: NetworkProfile[] }
export type NetworkInterface = { index: number; alias: string; physical: boolean; connected: boolean; addresses: string[]; metric: number }
export type NetworkRoute = { prefix: string; nextHop: string; interfaceIndex: number; interfaceAlias: string; metric: number; store: 'active' | 'persistent' }
export type SelectedNetworkRoute = { target: string; source: string; interfaceIndex: number; interfaceAlias: string; prefix: string; nextHop: string }
export type NetworkSnapshot = {
  id: string
  collectedAt: string
  platform: string
  elevated: boolean
  interfaces: NetworkInterface[]
  routes: NetworkRoute[]
  selectedRoutes: SelectedNetworkRoute[]
  vpn: { exists: boolean; connected: boolean; splitTunneling: boolean; routePrefixes: string[] }
  proxy: { available: boolean; mode: string; tunEnabled: boolean; controller: string; bypassPrefixes: string[]; configHash: string; instanceId?: string }
  tunnel: { serviceExists: boolean; running: boolean; taskExists: boolean; taskRunning: boolean; taskEnabled: boolean; latestHandshake: number | null }
  issues: string[]
}

export type NetworkStepId = 'physical' | 'vpn' | 'management' | 'proxy' | 'relay' | 'tunnel' | 'container'
export type NetworkStep = {
  id: NetworkStepId
  state: 'ready' | 'change' | 'manual' | 'blocked' | 'skipped'
  /** Stable translation key suffix; details contain only non-secret observed values. */
  code: string
  details: string[]
}
export type NetworkChange = {
  id: 'vpn-split' | 'vpn-route' | 'proxy-bypass' | 'relay-start' | 'tunnel-start' | 'office-route' | 'tunnel-stop' | 'relay-stop'
  before: string
  after: string
}
export type NetworkPlan = {
  id: string
  profileId: string
  snapshotId: string
  createdAt: string
  expiresAt: string
  steps: NetworkStep[]
  changes: NetworkChange[]
  /** Read-only projection of the actual main-process plan, not executable renderer input. */
  execution?: NetworkPlanExecution[]
  canApply: boolean
}
export type NetworkProbe = {
  target: string
  port?: number
  kind: 'tcp' | 'http-proxy' | 'http-direct' | 'route' | 'handshake'
  ok: boolean
  checkedAt: string
  latencyMs: number
  source?: string
  interfaceAlias?: string
  statusCode?: number
  detail: string
  hostId?: string
}
export type NetworkApplyReport = {
  planId: string
  status: 'applied' | 'rolled-back' | 'rollback-conflict' | 'failed'
  completedChanges: string[]
  rollback: string[]
  probes: NetworkProbe[]
  issues: string[]
}
export type VpnRouteTarget = { destination: string; vpnName: string; vpnScope: 'allUsers' | 'currentUser' }
export type VpnRouteOptions = { vpns: { name: string; scope: 'allUsers' | 'currentUser'; connected: boolean; splitTunneling: boolean; routes: { prefix: string; metric: number }[] }[] }
export type VpnRouteSelection = { target: string; source: string; interfaceAlias: string; prefix: string }
export type VpnRoutePlan = VpnRouteTarget & {
  id: string
  canApply: boolean
  alreadyBound: boolean
  expiresAt: string
  issues: string[]
  conflicts: { prefix: string; interfaceAlias: string; store: string }[]
  selected: VpnRouteSelection | null
}
export type VpnRouteApplyReport = { status: 'applied' | 'rolled-back' | 'rollback-conflict'; destination: string; selected: VpnRouteSelection | null; issues: string[] }
export type VpnRouteBatchInput = { destinations: string[]; vpnName: string; vpnScope: 'allUsers' | 'currentUser' }
export type VpnRouteBatchPlan = { id: string; vpnName: string; vpnScope: 'allUsers' | 'currentUser'; canApply: boolean; expiresAt: string; items: VpnRoutePlan[]; issues: string[] }
export type VpnRouteBatchReport = { status: 'applied' | 'rolled-back' | 'rollback-conflict'; destinations: string[]; selected: VpnRouteSelection[]; issues: string[] }
export type VpnRouteProbeInput = { address: string; port: number; protocol: 'tcp' | 'http' | 'https'; vpnName: string; vpnScope: 'allUsers' | 'currentUser' }
export type VpnRouteProbeResult = { selected: VpnRouteSelection | null; viaVpn: boolean; probe: NetworkProbe | null; issues: string[] }
export type NetworkResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
export type NetworkRequest =
  | { action: 'discoverProxy'; proxyPort: number }
  | { action: 'executionCatalog' }
  | { action: 'openNetworkConnections' }
  | { action: 'list' }
  | { action: 'save'; profile: NetworkProfile; expectedRevision: number }
  | { action: 'inspect'; profile: NetworkProfile }
  | { action: 'plan'; profile: NetworkProfile }
  | { action: 'apply'; planId: string }
  | { action: 'recover' }
  | { action: 'verify'; profile: NetworkProfile }
  | { action: 'probeHost'; hostId: string }
  | { action: 'login'; target: 'vpn' | 'sakura'; profile: NetworkProfile }
  | { action: 'vpnRouteOptions' }
  | { action: 'vpnRoutePreview'; target: VpnRouteTarget }
  | { action: 'vpnRouteApply'; planId: string }
  | { action: 'vpnRouteVerify'; target: VpnRouteTarget }
  | { action: 'vpnRouteBatchPreview'; input: VpnRouteBatchInput }
  | { action: 'vpnRouteBatchApply'; planId: string }
  | { action: 'vpnRouteBatchVerify'; input: VpnRouteBatchInput }
  | { action: 'vpnRouteProbe'; input: VpnRouteProbeInput }

export type NetworkManagerApi = {
  discoverProxy(proxyPort: number): Promise<NetworkResult<SakuraDiscovery>>
  executionCatalog(): Promise<NetworkResult<NetworkExecutionCatalog>>
  /** Opens ncpa.cpl only; no profile input, elevation or network mutation. */
  openNetworkConnections(): Promise<NetworkResult<null>>
  list(): Promise<NetworkResult<NetworkProfilesDocument>>
  save(profile: NetworkProfile, expectedRevision: number): Promise<NetworkResult<NetworkProfilesDocument>>
  inspect(profile: NetworkProfile): Promise<NetworkResult<NetworkSnapshot>>
  plan(profile: NetworkProfile): Promise<NetworkResult<{ snapshot: NetworkSnapshot; plan: NetworkPlan }>>
  apply(planId: string): Promise<NetworkResult<NetworkApplyReport>>
  recover(): Promise<NetworkResult<NetworkApplyReport>>
  verify(profile: NetworkProfile): Promise<NetworkResult<NetworkProbe[]>>
  probeHost(hostId: string): Promise<NetworkResult<NetworkProbe>>
  login(target: 'vpn' | 'sakura', profile: NetworkProfile): Promise<NetworkResult<null>>
  vpnRouteOptions(): Promise<NetworkResult<VpnRouteOptions>>
  vpnRoutePreview(target: VpnRouteTarget): Promise<NetworkResult<VpnRoutePlan>>
  vpnRouteApply(planId: string): Promise<NetworkResult<VpnRouteApplyReport>>
  vpnRouteVerify(target: VpnRouteTarget): Promise<NetworkResult<VpnRoutePlan>>
  vpnRouteBatchPreview(input: VpnRouteBatchInput): Promise<NetworkResult<VpnRouteBatchPlan>>
  vpnRouteBatchApply(planId: string): Promise<NetworkResult<VpnRouteBatchReport>>
  vpnRouteBatchVerify(input: VpnRouteBatchInput): Promise<NetworkResult<VpnRouteBatchPlan>>
  vpnRouteProbe(input: VpnRouteProbeInput): Promise<NetworkResult<VpnRouteProbeResult>>
}

/** A DIRECT proxy CIDR may cover a narrower target; this never creates an OS route. */
export function proxyBypassCovers(prefixes: string[], target: string): boolean {
  const parse = (value: string) => {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/.exec(value)
    if (!match) return null
    const parts = match[1]!.split('.').map(Number)
    if (parts.some(part => part > 255)) return null
    return { address: parts.reduce((sum, part) => sum * 256 + part, 0), bits: Number(match[2]) }
  }
  const desired = parse(target)
  if (!desired) return false
  return prefixes.some(prefix => {
    const source = parse(prefix)
    if (!source || source.bits > desired.bits) return false
    const size = 2 ** (32 - source.bits)
    return Math.floor(source.address / size) === Math.floor(desired.address / size)
  })
}

export function createDefaultNetworkProfiles(): [NetworkProfile, NetworkProfile] {
  const base = {
    vpnName: '124.114.142.77', vpnScope: 'allUsers' as const,
    managementPrefix: '191.168.0.0/16', gatewayAddress: '191.168.7.62', gatewayPort: 22,
    proxyConfigPath: '', sakuraExecutable: '', proxyPort: 7897,
    externalProbeUrl: 'https://www.google.com/generate_204',
    containerEnabled: true, containerPrefix: '10.204.19.0/24',
    containerProbeAddress: '10.204.19.81', containerProbePort: 8080,
    tunnelName: 'zjwj-arm62', relayTaskName: 'Zjwj Arm62 WireGuard TCP Relay', relayPort: 51826,
    expectedRelaySource: '162.168.1.2',
  }
  return [
    { ...base, id: 'home', name: '', mode: 'home' },
    { ...base, id: 'work', name: '', mode: 'work' },
  ]
}
