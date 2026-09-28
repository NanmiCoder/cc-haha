import { describe, expect, it } from 'vitest'
import { createDefaultNetworkProfiles } from './networkTypes'
import { isAddressInPrefix, migrateNetworkProfiles, NetworkProfileSchema, NetworkRequestSchema } from './networkSchemas'

describe('network configuration boundaries', () => {
  const home = createDefaultNetworkProfiles()[0]
  it('keeps home and office as separate desired profiles without hardcoded interface indices or credentials', () => {
    for (const profile of createDefaultNetworkProfiles()) expect(NetworkProfileSchema.parse(profile)).toEqual(profile)
    expect(home.managementPrefix).toBe('191.168.0.0/16')
    expect(home.expectedRelaySource).toBe('162.168.1.2')
    expect(Object.keys(home)).not.toContain('interfaceIndex')
  })
  it.each([
    { managementPrefix: '0.0.0.0/0' }, { containerPrefix: '10.0.0.0/8' },
    { containerPrefix: '10.204.19.1/24' }, { containerPrefix: '191.168.7.0/24', containerProbeAddress: '191.168.7.81' },
    { containerProbeAddress: '10.204.20.81' }, { gatewayAddress: '192.168.7.62' },
    { tunnelName: 'ops-server-v7' }, { tunnelName: 'other-company' }, { relayTaskName: 'Unrelated backup task' },
    { relayTaskName: 'CC-Haha *' }, { relayTaskName: 'Zjwj Arm62 [ab]' }, { vpnName: '*' },
    { proxyConfigPath: '\\\\server\\share\\config.yaml' }, { sakuraExecutable: 'C:\\run.cmd' },
    { externalProbeUrl: 'https://user:secret@example.org/' }, { externalProbeUrl: 'http://example.org/' },
    { password: 'must-not-be-persisted' }, { controllerSecret: 'must-not-be-persisted' },
    { vpnName: 'vpn\nSet-NetRoute' }, { proxyPort: 65536 },
  ])('rejects unsafe or contradictory profile fields %j', patch => {
    expect(NetworkProfileSchema.safeParse({ ...home, ...patch }).success).toBe(false)
  })
  it('only accepts a plan identifier for apply and a host identifier for managed-host probes', () => {
    expect(NetworkRequestSchema.safeParse({ action: 'apply', planId: 'server-plan' }).success).toBe(true)
    expect(NetworkRequestSchema.safeParse({ action: 'apply', planId: 'server-plan', changes: [] }).success).toBe(false)
    expect(NetworkRequestSchema.safeParse({ action: 'probeHost', hostId: '793bb617-022a-4dd1-85ca-e7e832dfc3fd' }).success).toBe(true)
    expect(NetworkRequestSchema.safeParse({ action: 'probeHost', hostId: '793bb617-022a-4dd1-85ca-e7e832dfc3fd', address: 'evil' }).success).toBe(false)
  })
  it('evaluates longest-prefix membership without signed IPv4 arithmetic', () => {
    expect(isAddressInPrefix('191.168.7.62', '191.168.0.0/16')).toBe(true)
    expect(isAddressInPrefix('191.169.7.62', '191.168.0.0/16')).toBe(false)
    expect(isAddressInPrefix('10.204.19.65', '10.204.19.65/32')).toBe(true)
    expect(isAddressInPrefix('10.204.19.66', '10.204.19.65/32')).toBe(false)
    expect(isAddressInPrefix('invalid', '10.204.19.0/24')).toBe(false)
  })
})

describe('network profile persistence migration', () => {
  it('migrates the frozen initial profile format without changing user choices', () => {
    const old = { schemaVersion: 0, profiles: [{ id: 'remote-a', name: 'Remote A', mode: 'home', vpnName: 'Company VPN', containerEnabled: false }] }
    const migrated = migrateNetworkProfiles(old)
    expect(migrated.schemaVersion).toBe(1)
    expect(migrated.profiles[0]).toMatchObject({ id: 'remote-a', name: 'Remote A', vpnName: 'Company VPN', containerEnabled: false, vpnScope: 'allUsers' })
    expect(migrateNetworkProfiles(migrated)).toEqual(migrated)
    expect(old.profiles[0]).not.toHaveProperty('proxyPort')
  })
  it('initializes missing storage but rejects future schemas, corruption and duplicate identities', () => {
    expect(migrateNetworkProfiles(null).profiles).toHaveLength(2)
    expect(migrateNetworkProfiles({ profiles: [] }).profiles).toHaveLength(2)
    expect(() => migrateNetworkProfiles({ schemaVersion: 9, revision: 7, profiles: [] })).toThrow()
    expect(() => migrateNetworkProfiles('corrupt')).toThrow()
    const profile = createDefaultNetworkProfiles()[0]
    expect(() => migrateNetworkProfiles({ schemaVersion: 1, revision: 0, profiles: [profile, profile] })).toThrow()
  })
})
