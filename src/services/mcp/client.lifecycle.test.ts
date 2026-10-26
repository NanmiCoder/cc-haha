import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  clearServerCache,
  connectToServer,
  fetchToolsForClient,
  getServerCacheKey,
  getMcpClientCacheKey,
  setMcpConnectionClosedHandler,
  reconnectMcpServerImpl,
} from './client.js'
import type { ScopedMcpServerConfig } from './types.js'
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js'

const config = { type: 'sse' as const, url: 'http://127.0.0.1:1/mcp' }
const name = 'lifecycle-test'
let root: string
let previousConfigDir: string | undefined
const extraConnections: Array<{ name: string; config: ScopedMcpServerConfig; cwd: string }> = []

async function connectAt(serverName: string, serverConfig: ScopedMcpServerConfig, cwd = getCwd()) {
  extraConnections.push({ name: serverName, config: serverConfig, cwd })
  const result = await runWithCwdOverride(cwd, () => connectToServer(serverName, serverConfig))
  if (result.type !== 'connected') throw new Error(`Fixture failed: ${result.type}`)
  return result
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-lifecycle-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

async function connect() {
  const result = await connectToServer(name, config)
  if (result.type !== 'connected') throw new Error(`Fixture failed: ${result.type}`)
  return result
}

afterEach(async () => {
  setMcpConnectionClosedHandler(undefined)
  await clearServerCache(name, config)
  for (const connection of extraConnections.splice(0)) {
    await runWithCwdOverride(connection.cwd, () => clearServerCache(connection.name, connection.config))
  }
  mock.restore()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

describe('MCP connection ownership', () => {
  test('reconnecting edited configuration closes the previous client and clears its tools only in this project', async () => {
    spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const old = await connectAt(name, config)
    const otherProject = await connectAt(name, config, root)
    const otherName = await connectAt('unrelated-server', config)
    const closeOld = spyOn(old.client, 'close').mockResolvedValue(undefined)
    const closeOtherProject = spyOn(otherProject.client, 'close').mockResolvedValue(undefined)
    const closeOtherName = spyOn(otherName.client, 'close').mockResolvedValue(undefined)
    await fetchToolsForClient(old)
    const nextConfig = { ...config, url: 'http://127.0.0.1:1/new' }
    extraConnections.push({ name, config: nextConfig, cwd: getCwd() })

    const next = await reconnectMcpServerImpl(name, nextConfig)

    expect(next.client.type).toBe('connected')
    expect(closeOld).toHaveBeenCalledTimes(1)
    expect(connectToServer.cache.has(getServerCacheKey(name, config))).toBe(false)
    expect(fetchToolsForClient.cache.has(getMcpClientCacheKey(old))).toBe(false)
    expect(closeOtherProject).not.toHaveBeenCalled()
    expect(closeOtherName).not.toHaveBeenCalled()
    expect(await runWithCwdOverride(root, () => connectToServer(name, config))).toBe(otherProject)
    expect(await connectToServer('unrelated-server', config)).toBe(otherName)
  })

  test('reconnecting edited configuration retires a previous pending handshake', async () => {
    const started = deferred()
    const handshake = deferred()
    spyOn(Client.prototype, 'connect').mockImplementationOnce(async () => {
      started.resolve()
      await handshake.promise
    }).mockResolvedValue(undefined)
    const close = spyOn(Client.prototype, 'close').mockResolvedValue(undefined)
    const oldConnecting = connectToServer(name, config)
    await started.promise
    const nextConfig = { ...config, url: 'http://127.0.0.1:1/replacement' }
    extraConnections.push({ name, config: nextConfig, cwd: getCwd() })
    try {
      const next = await reconnectMcpServerImpl(name, nextConfig)
      expect(next.client.type).toBe('connected')
      expect(close).toHaveBeenCalledTimes(1)
      expect(connectToServer.cache.has(getServerCacheKey(name, config))).toBe(false)
      handshake.resolve()
      expect((await oldConnecting).type).toBe('failed')
      expect(await connectToServer(name, nextConfig)).toBe(next.client)
    } finally {
      handshake.resolve()
      await oldConnecting
    }
  })

  test('concurrent configuration reconnects complete in order and retain only the latest client', async () => {
    spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const old = await connectAt(name, config)
    const closeStarted = deferred()
    const finishClose = deferred()
    old.client.close = async () => {
      closeStarted.resolve()
      await finishClose.promise
    }
    const firstConfig = { ...config, url: 'http://127.0.0.1:1/first' }
    const nextConfig = { ...config, url: 'http://127.0.0.1:1/latest' }
    extraConnections.push({ name, config: firstConfig, cwd: getCwd() }, { name, config: nextConfig, cwd: getCwd() })
    const firstReconnect = reconnectMcpServerImpl(name, firstConfig)
    try {
      await closeStarted.promise
      const latestReconnect = reconnectMcpServerImpl(name, nextConfig)
      finishClose.resolve()
      expect((await firstReconnect).client.type).toBe('connected')
      const latest = await latestReconnect
      expect(latest.client.type).toBe('connected')
      expect(await connectToServer(name, nextConfig)).toBe(latest.client)
      expect(connectToServer.cache.has(getServerCacheKey(name, firstConfig))).toBe(false)
    } finally {
      finishClose.resolve()
      await firstReconnect
    }
  })

  test('clearing an absent connection does not start a server', async () => {
    const open = spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    await clearServerCache(name, config)
    expect(open).not.toHaveBeenCalled()
  })

  test('an old close preserves a newer connection and its tools', async () => {
    spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const old = await connect()
    const finishClose = deferred()
    old.client.close = async () => {
      await finishClose.promise
      old.client.onclose?.()
    }
    const closing = old.cleanup()
    connectToServer.cache.delete(getServerCacheKey(name, config))
    const newer = await connect()
    const newTools = fetchToolsForClient(newer)
    await newTools
    const closed = mock(() => {})
    setMcpConnectionClosedHandler(closed)
    finishClose.resolve()
    await closing
    expect(await connectToServer(name, config) === newer).toBe(true)
    expect(fetchToolsForClient(newer)).toBe(newTools)
    expect(closed).not.toHaveBeenCalled()
  })

  test('a clear that finishes late does not evict a new connection', async () => {
    spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const old = await connect()
    const finishClose = deferred()
    old.client.close = async () => {
      await finishClose.promise
      old.client.onclose?.()
    }
    const clearing = clearServerCache(name, config)
    await Bun.sleep(0)
    // Re-enable creates its own connection while the old cleanup is pending.
    const newer = await connect()
    finishClose.resolve()
    await clearing
    expect(newer === old).toBe(false)
    expect(await connectToServer(name, config) === newer).toBe(true)
  })

  test('an active unexpected close invalidates caches and identifies its client', async () => {
    spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const active = await connect()
    await fetchToolsForClient(active)
    const closed = mock(() => {})
    setMcpConnectionClosedHandler(closed)
    active.client.onclose?.()
    expect(connectToServer.cache.has(getServerCacheKey(name, config))).toBe(false)
    expect(fetchToolsForClient.cache.has(getMcpClientCacheKey(active))).toBe(false)
    expect(closed).toHaveBeenCalledWith(name, active.client)
  })

  test('intentional cleanup does not request automatic reconnection', async () => {
    spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const active = await connect()
    active.client.close = async () => { active.client.onclose?.() }
    const closed = mock(() => {})
    setMcpConnectionClosedHandler(closed)
    await clearServerCache(name, config)
    expect(closed).not.toHaveBeenCalled()
  })
})
