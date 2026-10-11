import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  __setStdioProcessTreeKillForTests,
  clearServerCache,
  connectToServer,
} from './client.js'
import type { McpServerConfig } from './types.js'
import type { WindowsTaskkillSpawn } from '../../utils/windowsProcessTree.js'
import { runCleanupFunctions } from '../../utils/cleanupRegistry.js'
import * as stdioEnvironment from '../../utils/mcpStdioEnvironment.js'

// Far above any real pid_max, so a call that escaped the spy could not hit a
// real process.
const SERVER_PID = 99_999_999

let root: string
let previousConfigDir: string | undefined
let restorePid: (() => void) | undefined
const connected: Array<{ name: string; config: McpServerConfig }> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-stdio-cleanup-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  // No real server is started: connect() is stubbed and the transport reports
  // a fixed child pid — until it is closed, when the SDK forgets its process.
  spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
  const closedTransports = new WeakSet<object>()
  const originalClose = StdioClientTransport.prototype.close
  spyOn(StdioClientTransport.prototype, 'close').mockImplementation(async function (this: StdioClientTransport) {
    closedTransports.add(this)
    return originalClose.call(this)
  })
  const original = Object.getOwnPropertyDescriptor(StdioClientTransport.prototype, 'pid')!
  Object.defineProperty(StdioClientTransport.prototype, 'pid', {
    configurable: true,
    get(this: object) {
      return closedTransports.has(this) ? null : SERVER_PID
    },
  })
  restorePid = () => Object.defineProperty(StdioClientTransport.prototype, 'pid', original)
})

afterEach(async () => {
  for (const { name, config } of connected.splice(0)) {
    await clearServerCache(name, config)
  }
  __setStdioProcessTreeKillForTests()
  restorePid?.()
  mock.restore()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

/** Records signals; the server is gone as soon as anything checks for it. */
function recordProcessKills() {
  const calls: Array<[number, NodeJS.Signals | number | undefined]> = []
  spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    calls.push([pid, signal])
    if (signal === 0) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }
    return true
  }) as typeof process.kill)
  return {
    calls,
    signalsTo(pid: number) {
      return calls.filter(([target, signal]) => target === pid && signal !== 0).map(([, signal]) => signal)
    },
  }
}

async function connectStdio(name: string, config: McpServerConfig) {
  const result = await connectToServer(name, config)
  connected.push({ name, config })
  if (result.type !== 'connected') throw new Error(`Fixture failed: ${result.type}`)
  return result
}

describe('stdio MCP server cleanup', () => {
  test('a stdio server configured without `type` gets the same signal escalation as an explicit one', async () => {
    const kills = recordProcessKills()
    const result = await connectStdio('untyped-stdio-cleanup', {
      command: 'node',
      args: ['server.js'],
    })

    await result.cleanup()

    expect(kills.signalsTo(SERVER_PID)).toEqual(['SIGINT'])
  })

  test('an explicit stdio server is signalled on cleanup', async () => {
    const kills = recordProcessKills()
    const result = await connectStdio('typed-stdio-cleanup', {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
    })

    await result.cleanup()

    expect(kills.signalsTo(SERVER_PID)).toEqual(['SIGINT'])
  })
})

describe('stdio MCP server still connecting when the CLI shuts down', () => {
  // The connected cleanup is registered only after the handshake. A runtime
  // stopped while it starts (or one the server stopped recognising, #1485)
  // used to exit without touching the servers it had just spawned.
  async function startHandshakeThatNeverFinishes(name: string, config: McpServerConfig) {
    let handshakeStarted!: () => void
    const started = new Promise<void>((resolve) => { handshakeStarted = resolve })
    spyOn(Client.prototype, 'connect').mockImplementation(() => {
      handshakeStarted()
      return new Promise<void>(() => {})
    })
    void connectToServer(name, config)
    connected.push({ name, config })
    await started
  }

  test('graceful shutdown stops the server process, once', async () => {
    const kills = recordProcessKills()
    await startHandshakeThatNeverFinishes('connecting-at-shutdown', {
      command: 'node',
      args: ['server.js'],
    })

    await runCleanupFunctions()
    await runCleanupFunctions()

    expect(kills.signalsTo(SERVER_PID)).toEqual(['SIGTERM'])
  })

  test('a shutdown before the server is spawned keeps it from being spawned', async () => {
    let environmentReady!: () => void
    const heldEnvironment = new Promise<void>((resolve) => { environmentReady = resolve })
    const environmentRequested = new Promise<void>((resolve) => {
      spyOn(stdioEnvironment, 'getMcpStdioEnvironment').mockImplementation(async () => {
        resolve()
        await heldEnvironment
        return {}
      })
    })
    const handshake = spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const config: McpServerConfig = { command: 'node', args: ['server.js'] }
    const connecting = connectToServer('shutdown-before-spawn', config)
    connected.push({ name: 'shutdown-before-spawn', config })
    await environmentRequested

    await runCleanupFunctions()
    environmentReady()
    const result = await connecting

    expect(result.type).toBe('failed')
    expect(handshake).not.toHaveBeenCalled()
  })

  test('on Windows it stops the server tree, not just the cmd.exe wrapper', async () => {
    const kills = recordProcessKills()
    const commands: string[][] = []
    __setStdioProcessTreeKillForTests({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      spawn: (cmd) => {
        commands.push(cmd)
        return { exited: Promise.resolve(0) }
      },
    })
    await startHandshakeThatNeverFinishes('windows-connecting-at-shutdown', {
      command: 'npx',
      args: ['-y', 'example-mcp'],
    })

    await runCleanupFunctions()

    expect(commands).toEqual([['C:\\Windows\\System32\\taskkill.exe', '/PID', String(SERVER_PID), '/T', '/F']])
    expect(kills.signalsTo(SERVER_PID)).toEqual([])
  })
})

describe('stdio MCP server that fails to connect on Windows', () => {
  // The SDK's close() would end only the cmd.exe wrapper and forget the pid, so
  // a server still starting (a slow first `npx -y`) kept running unowned.
  const TASKKILL_COMMAND = ['C:\\Windows\\System32\\taskkill.exe', '/PID', String(SERVER_PID), '/T', '/F']
  let previousTimeout: string | undefined

  beforeEach(() => {
    previousTimeout = process.env.MCP_TIMEOUT
  })

  afterEach(() => {
    if (previousTimeout === undefined) delete process.env.MCP_TIMEOUT
    else process.env.MCP_TIMEOUT = previousTimeout
  })

  function windowsTaskkill() {
    const commands: string[][] = []
    __setStdioProcessTreeKillForTests({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      spawn: (cmd) => {
        commands.push(cmd)
        return { exited: Promise.resolve(0) }
      },
    })
    return commands
  }

  test('a connection that times out stops the whole server tree', async () => {
    recordProcessKills()
    const commands = windowsTaskkill()
    process.env.MCP_TIMEOUT = '30'
    spyOn(Client.prototype, 'connect').mockImplementation(() => new Promise<void>(() => {}))
    const config: McpServerConfig = { command: 'npx', args: ['-y', 'example-mcp'] }

    const result = await connectToServer('windows-connect-timeout', config)
    connected.push({ name: 'windows-connect-timeout', config })
    await Bun.sleep(0)

    expect(result.type).toBe('failed')
    expect(commands).toEqual([TASKKILL_COMMAND])
  })

  test('a connection that fails stops the whole server tree', async () => {
    recordProcessKills()
    const commands = windowsTaskkill()
    spyOn(Client.prototype, 'connect').mockRejectedValue(new Error('server exited during initialize'))
    const config: McpServerConfig = { command: 'npx', args: ['-y', 'example-mcp'] }

    const result = await connectToServer('windows-connect-failure', config)
    connected.push({ name: 'windows-connect-failure', config })
    await Bun.sleep(0)

    expect(result.type).toBe('failed')
    expect(commands).toEqual([TASKKILL_COMMAND])
  })
})

describe('stdio MCP server cleanup on Windows', () => {
  const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe'

  function useTaskkill(platform: NodeJS.Platform, exited: () => Promise<number>) {
    const commands: string[][] = []
    const spawn: WindowsTaskkillSpawn = (cmd) => {
      commands.push(cmd)
      return { exited: exited() }
    }
    __setStdioProcessTreeKillForTests({ platform, env: { SystemRoot: 'C:\\Windows' }, spawn })
    return commands
  }

  test('stops the whole server tree instead of terminating only its cmd.exe wrapper', async () => {
    const kills = recordProcessKills()
    const taskkill = useTaskkill('win32', () => Promise.resolve(0))
    const result = await connectStdio('windows-tree-cleanup', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'example-mcp'],
    })

    await result.cleanup()

    expect(taskkill).toEqual([[TASKKILL, '/PID', String(SERVER_PID), '/T', '/F']])
    expect(kills.signalsTo(SERVER_PID)).toEqual([])
  })

  test('applies to a server configured without `type`', async () => {
    const kills = recordProcessKills()
    const taskkill = useTaskkill('win32', () => Promise.resolve(0))
    const result = await connectStdio('windows-untyped-tree-cleanup', {
      command: 'npx',
      args: ['-y', 'example-mcp'],
    })

    await result.cleanup()

    expect(taskkill).toEqual([[TASKKILL, '/PID', String(SERVER_PID), '/T', '/F']])
    expect(kills.signalsTo(SERVER_PID)).toEqual([])
  })

  test('falls back to the per-pid escalation when taskkill fails', async () => {
    const kills = recordProcessKills()
    const taskkill = useTaskkill('win32', () => Promise.resolve(1))
    const result = await connectStdio('windows-tree-fallback', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'example-mcp'],
    })

    await result.cleanup()

    expect(taskkill).toHaveLength(1)
    expect(kills.signalsTo(SERVER_PID)).toEqual(['SIGINT'])
  })

  test('stays within the cleanup budget and leaves an unfinished taskkill alone', async () => {
    const kills = recordProcessKills()
    const taskkill = useTaskkill('win32', () => new Promise<number>(() => {}))
    const result = await connectStdio('windows-tree-pending', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'example-mcp'],
    })

    const startedAt = Date.now()
    await result.cleanup()
    const elapsedMs = Date.now() - startedAt

    expect(taskkill).toHaveLength(1)
    expect(elapsedMs).toBeLessThan(1_500)
    // Terminating cmd.exe while taskkill is still walking would orphan the
    // node server below it.
    expect(kills.signalsTo(SERVER_PID)).toEqual([])
  })

  test('POSIX keeps the per-pid signal escalation and never runs taskkill', async () => {
    const kills = recordProcessKills()
    const taskkill = useTaskkill('linux', () => Promise.resolve(0))
    const result = await connectStdio('posix-no-tree-cleanup', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'example-mcp'],
    })

    await result.cleanup()

    expect(taskkill).toEqual([])
    expect(kills.signalsTo(SERVER_PID)).toEqual(['SIGINT'])
  })
})
