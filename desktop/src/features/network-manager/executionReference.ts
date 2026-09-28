import type { TranslationKey } from '@/i18n'
import type { NetworkProfile, SakuraDiscovery } from './networkTypes'

export type ReferenceStage = 'profile' | 'physical' | 'vpn' | 'proxy' | 'containers' | 'plan' | 'verify' | 'binding'
export type ParameterReference = { label: TranslationKey; stage: ReferenceStage; actions: string[] }

/** One explicit mapping for every persisted parameter; no hidden executable settings. */
export const profileParameterReference = {
  id: { label: 'networkManager.ref.id', stage: 'profile', actions: ['saveProfile', 'plan'] },
  name: { label: 'networkManager.name', stage: 'profile', actions: ['saveProfile'] },
  mode: { label: 'networkManager.profile', stage: 'profile', actions: ['plan'] },
  managementPrefix: { label: 'networkManager.corporatePrefix', stage: 'physical', actions: ['vpnRouteAdd', 'proxy-bypass'] },
  gatewayAddress: { label: 'networkManager.gateway', stage: 'physical', actions: ['snapshot', 'routeAdd', 'tcp'] },
  gatewayPort: { label: 'networkManager.gatewayPort', stage: 'physical', actions: ['tcp'] },
  vpnName: { label: 'networkManager.vpnName', stage: 'vpn', actions: ['snapshot', 'split', 'vpnRouteAdd'] },
  vpnScope: { label: 'networkManager.vpnScope', stage: 'vpn', actions: ['snapshot', 'split', 'vpnRouteAdd'] },
  proxyConfigPath: { label: 'networkManager.proxyConfig', stage: 'proxy', actions: ['proxyDiscover', 'proxyController', 'proxyInspect', 'proxy-bypass'] },
  sakuraExecutable: { label: 'networkManager.sakuraPath', stage: 'proxy', actions: ['proxyDiscover', 'loginSakura'] },
  proxyPort: { label: 'networkManager.proxyEndpoint', stage: 'proxy', actions: ['proxyDiscover', 'proxyInspect', 'http-proxy'] },
  externalProbeUrl: { label: 'networkManager.proxyProbe', stage: 'proxy', actions: ['http-proxy'] },
  containerEnabled: { label: 'networkManager.containerEnabled', stage: 'containers', actions: ['plan', 'verify'] },
  containerPrefix: { label: 'networkManager.prefix', stage: 'containers', actions: ['proxy-bypass', 'routeAdd', 'routeRemove'] },
  containerProbeAddress: { label: 'networkManager.probeAddress', stage: 'containers', actions: ['snapshot', 'tcp'] },
  containerProbePort: { label: 'networkManager.probePort', stage: 'containers', actions: ['tcp'] },
  tunnelName: { label: 'networkManager.tunnel', stage: 'containers', actions: ['snapshot', 'service', 'serviceStartup'] },
  relayTaskName: { label: 'networkManager.service', stage: 'containers', actions: ['snapshot', 'task', 'taskEnabled'] },
  relayPort: { label: 'networkManager.relayPort', stage: 'containers', actions: ['tcp'] },
  expectedRelaySource: { label: 'networkManager.expectedSource', stage: 'containers', actions: ['plan', 'apply'] },
} satisfies Record<keyof NetworkProfile, ParameterReference>

export const stageReferenceActions: Record<ReferenceStage, string[]> = {
  profile: ['saveProfile', 'plan', 'openNetworkConnections'],
  physical: ['snapshot', 'inspect', 'tcp', 'openNetworkConnections'],
  vpn: ['snapshot', 'loginVpn', 'split', 'vpnRouteAdd', 'vpnRouteRemove', 'openNetworkConnections'],
  proxy: ['proxyDiscover', 'proxyController', 'proxyInspect', 'loginSakura', 'proxy-bypass', 'copyAcl', 'http-proxy'],
  containers: ['snapshot', 'service', 'serviceStartup', 'task', 'taskEnabled', 'routeAdd', 'routeRemove', 'tcp'],
  plan: ['plan', 'apply', 'recover', 'verify'],
  verify: ['probeHost', 'tcp'],
  binding: ['vpnBinding', 'vpnRouteAdd', 'vpnRouteRemove', 'routeAdd', 'routeRemove', 'snapshot', 'vpnRouteProbe', 'http-direct', 'tcp'],
}
export const stageEvidenceKey: Record<ReferenceStage, TranslationKey> = {
  profile: 'networkManager.ref.evidenceProfile', physical: 'networkManager.ref.evidencePhysical',
  vpn: 'networkManager.ref.evidenceVpn', proxy: 'networkManager.ref.evidenceProxy',
  containers: 'networkManager.ref.evidenceContainers', plan: 'networkManager.ref.evidencePlan',
  verify: 'networkManager.ref.evidenceVerify', binding: 'networkManager.ref.evidenceBinding',
}

/** Resolve only an observation matching the current proxy port. Never persist detection metadata. */
export function effectiveNetworkProfile(profile: NetworkProfile, discovery: SakuraDiscovery | null): NetworkProfile {
  const instance = discovery?.status === 'detected' && discovery.proxyPort === profile.proxyPort ? discovery.selected : null
  if (!instance) return profile
  return { ...profile, proxyConfigPath: instance.configPath, sakuraExecutable: instance.clientExecutable || profile.sakuraExecutable }
}

/** Diagnostic text is not a credential export; URLs never expose query/userinfo/fragment. */
export function safeReferenceValue(value: unknown): string {
  const safe = (input: unknown, depth = 0): unknown => {
    if (depth > 8) return '[LIMIT]'
    if (typeof input === 'string') {
      if (/^https?:\/\//i.test(input)) {
        try {
          const url = new URL(input)
          const hadQuery = !!url.search
          url.username = ''; url.password = ''; url.search = ''; url.hash = ''
          return `${url.toString()}${hadQuery ? '?[REDACTED]' : ''}`
        } catch { return '[INVALID URL]' }
      }
      return input
    }
    if (Array.isArray(input)) return input.map(item => safe(item, depth + 1))
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key,
      /secret|password|token|authorization|private.?key|subscription|commandline/i.test(key) ? '[REDACTED]' : safe(item, depth + 1)]))
    return input
  }
  const result = safe(value)
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? '—'
}
