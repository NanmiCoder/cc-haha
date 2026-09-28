import { z } from 'zod/v4'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { NetworkManagerApi, NetworkProfile } from '../../../desktop/src/features/network-manager/networkTypes.js'

export const NetworkConfigInputSchema = z.strictObject({
  action: z.enum(['locate', 'list_profiles', 'inspect_profile', 'verify_profile', 'list_hosts', 'probe_host']),
  profileId: z.string().min(1).max(80).optional().describe('Saved network profile ID returned by list_profiles'),
  hostId: z.string().uuid().optional().describe('Managed host ID returned by list_hosts'),
}).superRefine((input, ctx) => {
  const profileAction = input.action === 'inspect_profile' || input.action === 'verify_profile'
  if (profileAction !== (input.profileId !== undefined)) ctx.addIssue({ code: 'custom', path: ['profileId'], message: 'profileId is required only for profile inspection or verification' })
  if ((input.action === 'probe_host') !== (input.hostId !== undefined)) ctx.addIssue({ code: 'custom', path: ['hostId'], message: 'hostId is required only for probe_host' })
})
export type NetworkConfigInput = z.infer<typeof NetworkConfigInputSchema>
type HostSummary = { id: string; name: string; address: string; port: number }
type ReadOnlyNetworkApi = Pick<NetworkManagerApi, 'list' | 'plan' | 'verify' | 'probeHost'>
export type NetworkConfigAccess = { api: ReadOnlyNetworkApi; listHosts(): Promise<HostSummary[]> }

/** The agent reuses the desktop's config root and implementation but exposes no second writer. */
export async function createNetworkConfigAccess(configDir = getClaudeConfigHomeDir()): Promise<NetworkConfigAccess> {
  const [{ createNetworkManagerService }, { createResourceDocumentRepository }] = await Promise.all([
    import('../../../desktop/electron/services/networkManager/service.js'),
    import('../../../desktop/electron/services/managedResources/repositories/resourceDocumentRepository.js'),
  ])
  const repository = createResourceDocumentRepository({ activeConfigDir: configDir })
  const listHosts = async () => {
    const result = await repository.load()
    if (result.status !== 'ready') throw new Error('HOST_LIBRARY_UNAVAILABLE')
    return result.document.hosts.map(({ id, name, address, port }) => ({ id, name, address, port }))
  }
  const api = createNetworkManagerService({
    configDir,
    resolveHost: async id => (await listHosts()).find(host => host.id === id) ?? null,
    openExternal: async () => { throw new Error('USE_DESKTOP_NETWORK_TOOL') },
    openPath: async () => { throw new Error('USE_DESKTOP_NETWORK_TOOL') },
  })
  return { api, listHosts }
}

const location = {
  builtIn: true,
  tool: 'NetworkConfig',
  title: '网络配置 / Network configuration',
  desktopEntry: 'Desktop top bar: network icon immediately beside Host management / 桌面顶栏「主机管理」旁的网络图标',
  supportedSystem: 'Windows',
  modes: ['home: SakuraCat + existing corporate Windows VPN, optional dedicated container tunnel', 'work: SakuraCat + direct office LAN'],
  mutationWorkflow: 'Open the desktop network tool. In the VPN stage, bind an IP or CIDR to an existing Windows VPN by selecting the VPN, previewing conflicts, applying the reviewed route, and verifying actual selection. Home/work profiles have a separate save, preview and apply workflow. This agent tool only reads and probes; it does not modify network settings.',
  verificationScope: 'TCP success is not SSH authentication, application success, whole-subnet coverage, or failover proof.',
}

export async function executeNetworkConfig(
  raw: unknown,
  accessFactory: () => Promise<NetworkConfigAccess> = createNetworkConfigAccess,
): Promise<Record<string, unknown>> {
  const parsed = NetworkConfigInputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'INVALID_INPUT', location }
  const input = parsed.data
  if (input.action === 'locate') return { ok: true, ...location }
  try {
    const { api, listHosts } = await accessFactory()
    if (input.action === 'list_hosts') return { ok: true, hosts: await listHosts(), location }
    if (input.action === 'probe_host') return { ...await api.probeHost(input.hostId!), location }
    const profiles = await api.list()
    if (!profiles.ok) return { ...profiles, location }
    if (input.action === 'list_profiles') return {
      ok: true, profiles: profiles.data.profiles.map(profile => ({
        id: profile.id, name: profile.name || (profile.mode === 'home' ? '家庭网络 / Home' : '工作网络 / Work'),
        mode: profile.mode, managementPrefix: profile.managementPrefix, gatewayAddress: profile.gatewayAddress,
        containerEnabled: profile.containerEnabled, containerPrefix: profile.containerPrefix,
      })), location,
    }
    const profile: NetworkProfile | undefined = profiles.data.profiles.find(item => item.id === input.profileId)
    if (!profile) return { ok: false, error: 'PROFILE_NOT_FOUND', location }
    if (input.action === 'verify_profile') return { ...await api.verify(profile), location }
    const result = await api.plan(profile)
    if (!result.ok) return { ...result, location }
    // Native plans belong to this process and cannot be applied from agent output.
    const { steps, changes, canApply } = result.data.plan
    return { ok: true, snapshot: result.data.snapshot, preflight: { steps, changes, canApply }, location }
  } catch {
    return { ok: false, error: 'NETWORK_CONFIG_UNAVAILABLE', location }
  }
}
