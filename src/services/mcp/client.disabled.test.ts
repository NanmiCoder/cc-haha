import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearServerCache, connectToServer, ensureConnectedClient, fetchToolsForClient } from './client.js'
import { setMcpServerEnabled } from './config.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { _setGlobalConfigCacheForTesting, enableConfigs, getProjectPathForConfig } from '../../utils/config.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import type { ScopedMcpServerConfig } from './types.js'

let root: string
let config: ScopedMcpServerConfig
const name = 'disabled-stdio-regression'
let previousConfigDir: string | undefined

function inProject<T>(fn: () => T) { return runWithCwdOverride(root, fn) }
async function instances() {
  return (await readFile(join(root, 'instances'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
}
async function waitForInstance(count: number) {
  for (let i = 0; i < 200; i++) {
    if ((await instances()).length === count) return
    await Bun.sleep(10)
  }
  throw new Error('stdio fixture did not start')
}
async function connected() {
  const client = await inProject(() => connectToServer(name, config))
  if (client.type !== 'connected') throw new Error(`Fixture connection failed: ${client.type}`)
  return client
}
async function invoke(tool: Awaited<ReturnType<typeof fetchToolsForClient>>[number]) {
  return inProject(() => tool!.call(
    { text: 'echo' },
    { abortController: new AbortController(), setAppState: () => {} } as never,
    undefined as never,
    { message: { content: [] } } as never,
  ))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qa005-stdio-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
  _setGlobalConfigCacheForTesting(null)
  enableConfigs()
  await writeFile(join(root, 'server.cjs'), `
const fs = require('node:fs')
const readline = require('node:readline')
const instance = String(process.pid)
fs.appendFileSync(process.argv[2], instance + '\\n')
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const req = JSON.parse(line)
  if (req.id === undefined) return
  let result
  if (req.method === 'initialize') {
    while (process.argv[3] && !fs.existsSync(process.argv[3])) await new Promise(r => setTimeout(r, 10))
    result = { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
  } else if (req.method === 'tools/list') result = { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
  else if (req.method === 'tools/call') result = { content: [{ type: 'text', text: instance }] }
  else result = {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n')
})
`)
  config = { type: 'stdio', command: process.execPath, args: [join(root, 'server.cjs'), join(root, 'instances')], scope: 'project' }
})

afterEach(async () => {
  await inProject(() => clearServerCache(name, config))
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
  _setGlobalConfigCacheForTesting(null)
  await rm(root, { recursive: true, force: true })
})

describe('disabled MCP execution boundary', () => {
  test('old tool closure cannot spawn after disable; re-enable starts a fresh instance', async () => {
    const old = await connected()
    const [tool] = await fetchToolsForClient(old)
    await invoke(tool!)
    expect(await instances()).toHaveLength(1)
    inProject(() => setMcpServerEnabled(name, false))
    await inProject(() => clearServerCache(name, config))
    await expect(invoke(tool!)).rejects.toThrow('disabled')
    expect(await instances()).toHaveLength(1)
    inProject(() => setMcpServerEnabled(name, true))
    await invoke(tool!)
    expect(await instances()).toHaveLength(2)
    expect(new Set(await instances()).size).toBe(2)
  })

  test('cached connection and direct connection entry obey disable without control delivery', async () => {
    const old = await connected()
    inProject(() => setMcpServerEnabled(name, false))
    await expect(inProject(() => ensureConnectedClient(old))).rejects.toThrow('disabled')
    await expect(inProject(() => ensureConnectedClient({ ...old, config: { type: 'sdk', name, scope: 'dynamic' } }))).rejects.toThrow('disabled')
    expect((await inProject(() => connectToServer(name, config))).type).toBe('disabled')
    expect(await instances()).toHaveLength(1)
  })

  test('a retained closure keeps its project disabled state when invoked from another project', async () => {
    const old = await connected()
    const [tool] = await fetchToolsForClient(old)
    inProject(() => setMcpServerEnabled(name, false))
    const otherProject = join(root, 'other')
    await mkdir(otherProject)
    await expect(runWithCwdOverride(otherProject, () => ensureConnectedClient(old))).rejects.toThrow('disabled')
    await expect(invoke(tool!)).rejects.toThrow('disabled')
    expect(await instances()).toHaveLength(1)
  })

  test('same-name tools remain isolated across projects, including cache cleanup', async () => {
    const first = await connected()
    const firstTools = await fetchToolsForClient(first)
    const otherProject = join(root, 'other')
    await mkdir(otherProject)
    try {
      const second = await runWithCwdOverride(otherProject, () => connectToServer(name, config))
      expect(second.type).toBe('connected')
      const secondTools = await runWithCwdOverride(otherProject, () => fetchToolsForClient(second))
      expect(secondTools).not.toBe(firstTools)
      runWithCwdOverride(otherProject, () => setMcpServerEnabled(name, false))
      await runWithCwdOverride(otherProject, () => clearServerCache(name, config))
      const disabled = await runWithCwdOverride(otherProject, () => connectToServer(name, config))
      expect(await runWithCwdOverride(otherProject, () => fetchToolsForClient(disabled))).toEqual([])
      expect(await fetchToolsForClient(first)).toBe(firstTools)
      await expect(invoke(secondTools[0]!)).rejects.toThrow('disabled')
      await invoke(firstTools[0]!)
      expect(await instances()).toHaveLength(2)
    } finally {
      await runWithCwdOverride(otherProject, () => clearServerCache(name, config))
    }
  })

  test('disable during slow initialization prevents publishing the connected client', async () => {
    const ready = join(root, 'ready')
    config = { ...config, args: [...(config as { args: string[] }).args, ready] } as ScopedMcpServerConfig
    const pending = inProject(() => connectToServer(name, config))
    await waitForInstance(1)
    inProject(() => setMcpServerEnabled(name, false))
    await writeFile(ready, '')
    expect((await pending).type).toBe('disabled')
    expect(await instances()).toHaveLength(1)
  })

  test('clearing a disabled slow initialization cancels it without waiting for its handshake', async () => {
    const ready = join(root, 'ready')
    config = { ...config, args: [...(config as { args: string[] }).args, ready] } as ScopedMcpServerConfig
    const pending = inProject(() => connectToServer(name, config))
    await waitForInstance(1)
    inProject(() => setMcpServerEnabled(name, false))
    const clearing = inProject(() => clearServerCache(name, config))
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      clearing.then(() => 'cleared'),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked'), 1500) }),
    ])
    clearTimeout(timer)
    await writeFile(ready, '')
    await clearing
    await pending
    expect(result).toBe('cleared')
    expect(await instances()).toHaveLength(1)
  })

  test('an invalidated slow connection cannot win after rapid disable and re-enable', async () => {
    const ready = join(root, 'ready')
    config = { ...config, args: [...(config as { args: string[] }).args, ready] } as ScopedMcpServerConfig
    const pending = inProject(() => connectToServer(name, config))
    await waitForInstance(1)
    inProject(() => setMcpServerEnabled(name, false))
    const clearing = inProject(() => clearServerCache(name, config))
    inProject(() => setMcpServerEnabled(name, true))
    const newer = inProject(() => connectToServer(name, config))
    await waitForInstance(2)
    await writeFile(ready, '')
    expect((await pending).type).not.toBe('connected')
    expect((await newer).type).toBe('connected')
    await clearing
    expect(await inProject(() => connectToServer(name, config))).toBe(await newer)
  })
})
