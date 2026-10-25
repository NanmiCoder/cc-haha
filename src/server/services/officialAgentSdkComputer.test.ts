import { afterEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ComputerUseHostAdapter } from '../../vendor/computer-use-mcp/types.js'
import type { CodexComputerEngine, ComputerExecutor } from '../../vendor/computer-use-mcp/executor.js'
import { ComputerUseRepl } from '../../utils/computerUse/replRuntime.js'
import { createOfficialAgentSdkComputer } from './officialAgentSdkComputer.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  let enabled = false
  let osAllowed = true
  let lockOwner: string | undefined
  let releases = 0
  const calls: string[] = []
  const adapter: ComputerUseHostAdapter = {
    serverName: 'fixture', logger: { silly() {}, debug() {}, info() {}, warn() {}, error() {} },
    isDisabled: () => false, ensureOsPermissions: async () => ({ granted: osAllowed }),
    getAutoUnhideEnabled: () => true,
    getSubGates: () => ({ pixelValidation: false, clipboardPasteMultiline: false, mouseAnimation: false, hideBeforeAction: false, autoTargetDisplay: false, clipboardGuard: false }),
    cropRawPatch: () => null,
    createReplRuntime: () => new ComputerUseRepl(),
    executor: { capabilities: { platform: 'darwin', screenshotFiltering: 'native', hostBundleId: 'dev.fixture' },
      engine: {
        async resolveTarget() { calls.push('resolve'); return { pid: 12, bundleId: 'dev.fixture.App', displayName: 'Fixture', path: '/Applications/Fixture.app', executablePath: '/Applications/Fixture.app/main', launchTime: 1, processIdentity: { pid: 12, bundleId: 'dev.fixture.App', executablePath: '/Applications/Fixture.app/main', launchTime: 1 } } },
        async getAppState() { calls.push('state'); return { pid: 12, elementCount: 1, truncated: false, durationMs: 1, axText: 'App=Fixture\n g1:1 button Fixture' } },
        async click() { calls.push('click') },
      } as unknown as CodexComputerEngine,
    } as ComputerExecutor,
  }
  const computer = await createOfficialAgentSdkComputer({ adapter,
    loadSettings: async () => ({ enabled, authorizedApps: [], grantFlags: { clipboardRead: true, clipboardWrite: true, systemKeyCombos: true }, pythonPath: null }),
    checkLock: async () => ({ holder: lockOwner, isSelf: lockOwner === 'self' }),
    acquireLock: async () => { lockOwner ??= 'self' },
    release: async () => { if (lockOwner === 'self') lockOwner = undefined; releases++ },
  })
  const client = new Client({ name: 'fixture', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(left), computer.server.instance.connect(right)])
  cleanups.push(async () => { await computer.close(); await client.close() })
  return { computer, client, calls, enable(value: boolean) { enabled = value }, allowOs(value: boolean) { osAllowed = value }, lock(value: string | undefined) { lockOwner = value }, releases: () => releases,
    call(code: string) { return client.callTool({ name: 'js', arguments: { code } }) },
  }
}

test('official Computer Use MCP follows the Settings consent boundary and disablement before native calls', async () => {
  const f = await fixture()
  expect((await f.client.listTools()).tools).toEqual([])
  expect((await f.call('await cua.getApp("Fixture")')).isError).toBe(true)
  expect(f.calls).toEqual([])
  f.enable(true)
  expect((await f.client.listTools()).tools.map(tool => tool.name)).toEqual(['js', 'js_reset'])
  expect((await f.call('let app = await cua.getApp("Fixture")')).isError).not.toBe(true)
  expect(f.calls).toEqual(['resolve', 'state'])
  expect((await f.call('await app.click("g1:1")')).isError).not.toBe(true)
  expect(f.calls).toContain('click')
  f.enable(false)
  const count = f.calls.length
  expect((await f.call('await app.click("g1:1")')).isError).toBe(true)
  expect(f.calls).toHaveLength(count)
  await f.computer.onTurnEnd()
  expect(f.releases()).toBe(1)
})

test('official Computer Use MCP retains native OS permission and concurrent-session lock failures', async () => {
  const f = await fixture()
  f.enable(true)
  f.allowOs(false)
  const denied = await f.call('await cua.getApp("Fixture")')
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied)).toContain('Accessibility')
  expect(f.calls).toEqual([])
  f.allowOs(true)
  f.lock('another-session')
  expect((await f.call('await cua.getApp("Fixture")')).isError).toBe(true)
  expect(f.calls).toEqual([])
})
