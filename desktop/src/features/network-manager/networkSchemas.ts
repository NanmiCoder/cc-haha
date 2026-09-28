import { z } from 'zod'
import { createDefaultNetworkProfiles, type NetworkProfilesDocument } from './networkTypes'

const text = z.string().max(160).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed')
const systemName = text.min(1).refine(value => !/[*?\[\]\\/]/.test(value), 'Choose an exact connection or task name without wildcards')
const ipv4 = z.ipv4()
const port = z.number().int().min(1).max(65535)
const prefix = z.string().refine(value => {
  const [address, bits, extra] = value.split('/')
  if (!address || extra !== undefined || !ipv4.safeParse(address).success || !/^\d+$/.test(bits ?? '')) return false
  const length = Number(bits)
  // A mode owns a narrow destination only, never a catch-all or a whole 10/8.
  if (length < 16 || length > 32) return false
  const number = address.split('.').reduce((sum, part) => sum * 256 + Number(part), 0)
  return number % (2 ** (32 - length)) === 0 && !address.startsWith('127.') && address !== '0.0.0.0'
}, 'Use a canonical IPv4 prefix between /16 and /32')
const localFile = (extension: RegExp) => z.string().max(2048).refine(value =>
  value === '' || (/^[a-z]:[\\/]/i.test(value) && !/[\u0000-\u001f"<>|*?]/.test(value) && extension.test(value)),
'Choose a local absolute Windows file path')

export function isAddressInPrefix(address: string, cidr: string): boolean {
  if (!ipv4.safeParse(address).success) return false
  const [network, mask] = cidr.split('/')
  if (!network || !ipv4.safeParse(network).success || !/^\d+$/.test(mask ?? '') || Number(mask) > 32) return false
  const numeric = (value: string) => value.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0)
  const size = 2 ** (32 - Number(mask))
  return Math.floor(numeric(address) / size) === Math.floor(numeric(network) / size)
}

export const NetworkProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  name: text,
  mode: z.enum(['home', 'work']),
  vpnName: systemName,
  vpnScope: z.enum(['allUsers', 'currentUser']),
  managementPrefix: prefix,
  gatewayAddress: ipv4,
  gatewayPort: port,
  proxyConfigPath: localFile(/\.ya?ml$/i),
  sakuraExecutable: localFile(/\.exe$/i),
  proxyPort: port,
  externalProbeUrl: z.url().max(2048).refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
  }, 'Use an HTTPS URL without credentials'),
  containerEnabled: z.boolean(),
  containerPrefix: prefix,
  containerProbeAddress: ipv4,
  containerProbePort: port,
  tunnelName: z.string().max(64).regex(/^(?:zjwj-|cc-haha-)[a-zA-Z0-9_-]+$/, 'Use a dedicated zjwj- or cc-haha- tunnel'),
  relayTaskName: systemName.regex(/^(?:Zjwj Arm62 |CC-Haha ).+$/, 'Use a dedicated relay task'),
  relayPort: port,
  expectedRelaySource: z.union([z.literal(''), ipv4]),
}).strict().superRefine((value, ctx) => {
  if (!isAddressInPrefix(value.gatewayAddress, value.managementPrefix)) {
    ctx.addIssue({ code: 'custom', path: ['gatewayAddress'], message: 'Gateway must belong to the management prefix' })
  }
  if (value.containerEnabled) {
    if (!isAddressInPrefix(value.containerProbeAddress, value.containerPrefix)) {
      ctx.addIssue({ code: 'custom', path: ['containerProbeAddress'], message: 'Probe must belong to the container prefix' })
    }
    if (isAddressInPrefix(value.gatewayAddress, value.containerPrefix)
      || isAddressInPrefix(value.containerPrefix.split('/')[0]!, value.managementPrefix)
      || isAddressInPrefix(value.managementPrefix.split('/')[0]!, value.containerPrefix)) {
      ctx.addIssue({ code: 'custom', path: ['containerPrefix'], message: 'Container and management prefixes must not overlap' })
    }
  }
})

export const NetworkRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('discoverProxy'), proxyPort: port }).strict(),
  z.object({ action: z.literal('executionCatalog') }).strict(),
  z.object({ action: z.literal('openNetworkConnections') }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('recover') }).strict(),
  z.object({ action: z.literal('save'), profile: NetworkProfileSchema, expectedRevision: z.number().int().nonnegative() }).strict(),
  ...(['inspect', 'plan', 'verify'] as const).map(action => z.object({ action: z.literal(action), profile: NetworkProfileSchema }).strict()),
  z.object({ action: z.literal('apply'), planId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('probeHost'), hostId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('login'), target: z.enum(['vpn', 'sakura']), profile: NetworkProfileSchema }).strict(),
  z.object({ action: z.literal('vpnRouteOptions') }).strict(),
  z.object({ action: z.literal('vpnRoutePreview'), target: z.object({ destination: z.string().max(50), vpnName: systemName, vpnScope: z.enum(['allUsers', 'currentUser']) }).strict() }).strict(),
  z.object({ action: z.literal('vpnRouteVerify'), target: z.object({ destination: z.string().max(50), vpnName: systemName, vpnScope: z.enum(['allUsers', 'currentUser']) }).strict() }).strict(),
  z.object({ action: z.literal('vpnRouteApply'), planId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('vpnRouteBatchPreview'), input: z.object({ destinations: z.array(z.string().max(50)).min(1).max(32), vpnName: systemName, vpnScope: z.enum(['allUsers', 'currentUser']) }).strict() }).strict(),
  z.object({ action: z.literal('vpnRouteBatchVerify'), input: z.object({ destinations: z.array(z.string().max(50)).min(1).max(32), vpnName: systemName, vpnScope: z.enum(['allUsers', 'currentUser']) }).strict() }).strict(),
  z.object({ action: z.literal('vpnRouteBatchApply'), planId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal('vpnRouteProbe'), input: z.object({ address: z.string().max(50), port, protocol: z.enum(['tcp', 'http', 'https']), vpnName: systemName, vpnScope: z.enum(['allUsers', 'currentUser']) }).strict() }).strict(),
])

export const NetworkProfilesDocumentSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  profiles: z.array(NetworkProfileSchema).min(1).max(30),
}).strict().refine(document => new Set(document.profiles.map(profile => profile.id)).size === document.profiles.length, 'Duplicate profile IDs')

/** Absent storage and the initial unversioned format migrate forward; future schemas never get overwritten. */
export function migrateNetworkProfiles(raw: unknown): NetworkProfilesDocument {
  if (raw === null || raw === undefined) return { schemaVersion: 1, revision: 0, profiles: createDefaultNetworkProfiles() }
  const legacy = z.object({ schemaVersion: z.literal(0).optional(), profiles: z.array(z.record(z.string(), z.unknown())).max(30) }).strict().safeParse(raw)
  if (legacy.success) {
    const defaults = createDefaultNetworkProfiles()
    return NetworkProfilesDocumentSchema.parse({
      schemaVersion: 1, revision: 0,
      profiles: legacy.data.profiles.length ? legacy.data.profiles.map(profile => ({
        ...defaults[profile.mode === 'work' ? 1 : 0], ...profile,
      })) : defaults,
    })
  }
  return NetworkProfilesDocumentSchema.parse(raw)
}
