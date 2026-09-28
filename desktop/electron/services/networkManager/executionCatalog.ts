import type { NetworkExecutionAction, NetworkExecutionCatalog } from '../../../src/features/network-manager/networkTypes'
import { NETWORK_SCRIPT } from './powershell'
import { SAKURA_DISCOVERY_FUNCTIONS } from './proxyDiscoveryScript'

const nativeSource = 'desktop/electron/services/networkManager/powershell.ts#NETWORK_SCRIPT'
const serviceSource = 'desktop/electron/services/networkManager/service.ts#createNetworkManagerService'

/** The displayed branch is extracted from exactly the constant the executor runs. */
export function networkScriptBranch(action: string): string {
  const marker = `  '${action}' {`
  const start = NETWORK_SCRIPT.indexOf(marker)
  if (start < 0) throw new Error('UNKNOWN_NETWORK_SCRIPT_ACTION')
  const rest = NETWORK_SCRIPT.slice(start)
  const end = rest.slice(marker.length).search(/\n  (?:'[^']+'|default) \{/)
  const branch = end < 0 ? rest.replace(/\n}\s*$/, '') : rest.slice(0, marker.length + end)
  const vpnArgs = NETWORK_SCRIPT.split('\n').find(line => line.startsWith('function VpnArgs ')) ?? ''
  return [
    ['proxyDiscover', 'proxyController'].includes(action) ? SAKURA_DISCOVERY_FUNCTIONS.trim() : '',
    ['split', 'vpnRouteAdd', 'vpnRouteRemove'].includes(action) ? vpnArgs : '',
    branch.trim(),
  ].filter(Boolean).join('\n\n')
}

/** Read-only source catalogue: never reads a user file, runs a command or fetches credentials. */
export function getNetworkExecutionCatalog(): NetworkExecutionCatalog {
  const actions: NetworkExecutionAction[] = ['snapshot', 'proxyDiscover', 'proxyController', 'copyAcl', 'split', 'vpnRouteAdd', 'vpnRouteRemove', 'routeAdd', 'routeRemove', 'service', 'serviceStartup', 'task', 'taskEnabled'].map(id => ({
    id, kind: ['snapshot', 'proxyDiscover', 'proxyController'].includes(id) ? 'read' : 'write',
    source: nativeSource, functionName: 'runNetworkPowerShell', script: networkScriptBranch(id),
  }))
  const add = (id: string, kind: NetworkExecutionAction['kind'], source: string, functionName: string, script = '') => actions.push({ id, kind, source, functionName, script })
  add('saveProfile', 'save', 'desktop/electron/services/networkManager/repository.ts', 'createNetworkRepository().save(profile, expectedRevision)')
  add('inspect', 'read', serviceSource, 'inspect(profile) → observe(profile)')
  add('plan', 'read', serviceSource, 'plan(profile) → observe(profile) → buildPlan(profile, observation)')
  add('apply', 'write', serviceSource, 'apply(planId) → stableSnapshot → runner(command) → verify(profile)')
  add('recover', 'write', serviceSource, 'recover() → readJournal() → rollback(journal, report)')
  add('verify', 'probe', serviceSource, 'verify(profile) → routeCheck / probeTcp / probeHttpProxy')
  add('openNetworkConnections', 'launch', serviceSource, 'openNetworkConnections() → Electron shell.openPath(system applet)', 'ncpa.cpl\nTarget: <SystemRoot>\\System32\\ncpa.cpl\nNative Windows file association; no cmd or PowerShell; no renderer arguments.\nOpens the window only. Adapter changes are manual; re-inspect before applying a plan.')
  add('loginVpn', 'launch', serviceSource, "login('vpn', profile) → openExternal('ms-settings:network-vpn')")
  add('loginSakura', 'launch', serviceSource, "login('sakura', profile) → discoverSakura → openPath(profile.sakuraExecutable)")
  add('proxyInspect', 'read', 'desktop/electron/services/networkManager/proxy.ts', 'createProxyAdapter().inspect(profile)', 'GET /version\nGET /configs\nGET /rules\nAuthorization: Bearer [REDACTED]')
  add('proxy-bypass', 'write', 'desktop/electron/services/networkManager/proxy.ts', 'createProxyAdapter().apply(profile, expectedHash) / rollback(profile, undo)', 'YAML: mode = rule; insert required IP-CIDR,…,DIRECT,no-resolve rules\nPUT /configs?force=true\nJSON body: { "path": "<verified config path>" }\nAuthorization: Bearer [REDACTED]')
  add('tcp', 'probe', 'desktop/electron/services/networkManager/probes.ts', 'probeTcp(target, port)')
  add('http-proxy', 'probe', 'desktop/electron/services/networkManager/probes.ts', 'probeHttpProxy(target, proxyPort)')
  add('http-direct', 'probe', 'desktop/electron/services/networkManager/probes.ts', 'probeDirectHttp(address, port, protocol)')
  add('probeHost', 'probe', serviceSource, 'probeHost(hostId) → resolveHost(hostId) → probeTcp(host.address, host.port)')
  add('vpnBinding', 'write', serviceSource, 'vpnRouteBatchPreview / vpnRouteBatchApply → activateBinding → selectedVpn; failure → rollbackBinding')
  add('vpnRouteProbe', 'probe', serviceSource, 'vpnRouteProbe(input) → observeBinding → probeTcp / probeDirectHttp')
  return { actions, executor: 'runNetworkPowerShell: Windows PowerShell -NoProfile -NonInteractive -EncodedCommand; JSON parameters on stdin; shell=false; 30s timeout; 2 MB output limit.' }
}
