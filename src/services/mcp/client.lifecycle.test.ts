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
} from './client.js'

const config = { type: 'sse' as const, url: 'http://127.0.0.1:1/mcp' }
const name = 'lifecycle-test'
let root: string
let previousConfigDir: string | undefined

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
  mock.restore()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

describe('MCP connection ownership', () => {
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

  // `scope` records where a definition came from, not what the connection is, so
  // it must not be part of the connection's identity. When it was, a reconnect
  // that resolved the config through `getMcpConfigByName` (file-scoped) could not
  // clear the entry cached under `scope:'dynamic'`, and the old connection — with
  // its child process — stayed alive.
  test('a clear with a differing scope still closes the same connection', async () => {
    spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const dynamic = { ...config, scope: 'dynamic' as const }
    const fileScoped = { ...config, scope: 'user' as const }
    expect(getServerCacheKey(name, dynamic)).toBe(getServerCacheKey(name, fileScoped))

    const active = await connect()
    let closed = 0
    active.client.close = async () => { closed += 1; active.client.onclose?.() }

    await clearServerCache(name, fileScoped)
    expect(closed).toBe(1)
    expect(connectToServer.cache.has(getServerCacheKey(name, dynamic))).toBe(false)
  })

  test('same-name definitions in different scopes share one connection', async () => {
    spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const dynamic = { ...config, scope: 'dynamic' as const }
    const fileScoped = { ...config, scope: 'project' as const }
    const first = await connectToServer(name, dynamic)
    const second = await connectToServer(name, fileScoped)
    expect(second === first).toBe(true)
  })
})
