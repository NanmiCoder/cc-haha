import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NetworkConfigTool } from './NetworkConfigTool.js'
import { createNetworkConfigAccess, executeNetworkConfig, NetworkConfigInputSchema, type NetworkConfigAccess } from './networkConfigAccess.js'
import { createDefaultNetworkProfiles } from '../../../desktop/src/features/network-manager/networkTypes.js'

const temporary: string[] = []
afterEach(async () => { for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })

describe('built-in NetworkConfig agent tool', () => {
  it('is immediately discoverable and returns the desktop entry without opening files or changing settings', async () => {
    expect(NetworkConfigTool.name).toBe('NetworkConfig')
    expect(NetworkConfigTool.alwaysLoad).toBe(true)
    expect(NetworkConfigTool.isEnabled()).toBe(true)
    expect(NetworkConfigTool.isReadOnly()).toBe(true)
    expect(await NetworkConfigTool.description()).toContain('家庭网络')
    expect(await NetworkConfigTool.description()).toContain('IP 网段绑定')
    const result = await executeNetworkConfig({ action: 'locate' }, async () => { throw new Error('must not initialize system access') })
    expect(result).toMatchObject({ ok: true, builtIn: true, tool: 'NetworkConfig' })
    expect(result.desktopEntry).toContain('主机管理')
    expect(result.mutationWorkflow).toContain('bind an IP or CIDR')
    const modelResult = NetworkConfigTool.mapToolResultToToolResultBlockParam(result, 'tool-use-fixture')
    expect(modelResult).toMatchObject({ type: 'tool_result', tool_use_id: 'tool-use-fixture' })
    expect(modelResult.content).toContain('network icon')
    const called = await NetworkConfigTool.call({ action: 'locate' })
    expect(called.data).toMatchObject({ ok: true, builtIn: true, tool: 'NetworkConfig' })
  })

  it('has no action for agent-supplied scripts, raw targets, credentials or applying changes', () => {
    for (const input of [
      { action: 'apply', planId: 'x' }, { action: 'login', password: 'fake' },
      { action: 'probe_host', hostId: 'invalid' }, { action: 'probe_host', hostId: '793bb617-022a-4dd1-85ca-e7e832dfc3fd', address: '127.0.0.1' },
      { action: 'inspect_profile' }, { action: 'locate', profileId: 'home' },
      { action: 'list_profiles', command: 'New-NetRoute' },
    ]) expect(NetworkConfigInputSchema.safeParse(input).success).toBe(false)
  })

  it('uses the same isolated profile and managed-host stores and returns no host credentials', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-agent-test-'))
    temporary.push(directory)
    const fixture = JSON.parse(await fs.readFile(path.resolve(import.meta.dir, '../../../fixtures/managed-resources/contract-v2.fixture.json'), 'utf8'))
    const hostPath = path.join(directory, 'cc-haha', 'host-management', 'resources.json')
    await fs.mkdir(path.dirname(hostPath), { recursive: true })
    await fs.writeFile(hostPath, JSON.stringify(fixture.resourceDocument))
    const profilesPath = path.join(directory, 'network-modes.json')
    const profiles = createDefaultNetworkProfiles()
    profiles[0].name = 'Fixture home'
    profiles[0].sakuraExecutable = 'C:\\fixture\\sakura.exe'
    const original = JSON.stringify({ schemaVersion: 1, revision: 7, profiles })
    await fs.writeFile(profilesPath, original)
    const access = await createNetworkConfigAccess(directory)
    const list = await executeNetworkConfig({ action: 'list_profiles' }, async () => access)
    expect(list.ok).toBe(true)
    expect(list.profiles).toHaveLength(2)
    expect(JSON.stringify(list)).not.toContain('sakura.exe')
    expect(JSON.stringify(list)).toContain('Fixture home')
    const hosts = await executeNetworkConfig({ action: 'list_hosts' }, async () => access)
    expect(hosts.ok).toBe(true)
    expect(hosts.hosts).toHaveLength(fixture.resourceDocument.hosts.length)
    expect(Object.keys((hosts.hosts as object[])[0]!)).toEqual(['id', 'name', 'address', 'port'])
    expect(await fs.readFile(profilesPath, 'utf8')).toBe(original)
    expect(await fs.readdir(directory)).toEqual(['cc-haha', 'network-modes.json'])
  })

  it('resolves saved profiles before inspection and strips non-reusable plan identifiers from model output', async () => {
    const calls: unknown[] = []
    const profiles = createDefaultNetworkProfiles()
    const access: NetworkConfigAccess = {
      listHosts: async () => [],
      api: {
        list: async () => ({ ok: true, data: { schemaVersion: 1, revision: 1, profiles } }),
        plan: async profile => {
          calls.push(profile)
          return { ok: true, data: { snapshot: { id: 'snapshot' } as never, plan: { id: 'native-only-plan', steps: [], changes: [], canApply: false } as never } }
        },
        verify: async () => ({ ok: true, data: [] }),
        probeHost: async id => { calls.push(id); return { ok: false, error: { code: 'HOST_NOT_FOUND', message: 'HOST_NOT_FOUND' } } },
      },
    }
    const result = await executeNetworkConfig({ action: 'inspect_profile', profileId: 'home' }, async () => access)
    expect(result).toMatchObject({ ok: true, preflight: { canApply: false } })
    expect(JSON.stringify(result)).not.toContain('native-only-plan')
    expect(calls).toEqual([profiles[0]])
    expect(await executeNetworkConfig({ action: 'inspect_profile', profileId: 'absent' }, async () => access)).toMatchObject({ ok: false, error: 'PROFILE_NOT_FOUND' })
    expect(await executeNetworkConfig({ action: 'probe_host', hostId: '793bb617-022a-4dd1-85ca-e7e832dfc3fd' }, async () => access)).toMatchObject({ ok: false, error: { code: 'HOST_NOT_FOUND' } })
  })

  it('is registered in the normal built-in catalog, not only mentioned in a prompt', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'network-agent-registry-'))
    temporary.push(directory)
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = directory
    try {
      const { getAllBaseTools } = await import('../../tools.js')
      const found = getAllBaseTools().find(tool => tool.name === NetworkConfigTool.name)
      expect(found).toBe(NetworkConfigTool)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })
})
