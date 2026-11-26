import { afterEach, describe, expect, test } from 'bun:test'
import type { ComputerUseHostAdapter } from '../../vendor/computer-use-mcp/types.js'
import {
  ANTIGRAVITY_COMPUTER_USE_SERVER_NAME,
  buildAntigravityComputerUsePrompt,
  createAntigravityComputerUseBridge,
  isAntigravityComputerUseToolName,
  resetAntigravityComputerUseBridgeLockForTests,
  type AntigravityComputerUseBridge,
  type ComputerUseLockOps,
} from './antigravityComputerUseBridge.js'

const noopLogger = {
  silly() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function makeFakeMacAdapter(calls: Array<{ code: string; timeoutMs: number }>): ComputerUseHostAdapter {
  return {
    serverName: 'computer-use',
    logger: noopLogger,
    isDisabled: () => false,
    getSubGates: () => ({ mouseAnimation: false, hideBeforeAction: false }),
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
    ensureOsPermissions: async () => ({ granted: true as const }),
    createReplRuntime: () => ({
      async run(request) {
        if (request.isAborted?.() || request.signal?.aborted) {
          return { isError: true, content: [{ type: 'text', text: 'aborted' }] }
        }
        calls.push({ code: request.code, timeoutMs: request.timeoutMs })
        return {
          content: [{ type: 'text', text: `REPL_OK:${request.code}` }],
        }
      },
      async reset() {},
    }),
    executor: {
      capabilities: {
        platform: 'darwin',
        screenshotFiltering: 'none',
      },
      listInstalledApps: async () => [],
    } as unknown as ComputerUseHostAdapter['executor'],
  }
}

function makeFakeAgentDesktopAdapter(calls: Array<{ command: string; args: string[] }>): ComputerUseHostAdapter {
  return {
    serverName: 'computer-use',
    logger: noopLogger,
    isDisabled: () => false,
    getSubGates: () => ({ mouseAnimation: false, hideBeforeAction: false }),
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
    ensureOsPermissions: async () => ({ granted: true as const }),
    executor: {
      capabilities: {
        platform: 'linux',
        screenshotFiltering: 'none',
        agentDesktop: true,
      },
      listInstalledApps: async () => [],
    } as unknown as ComputerUseHostAdapter['executor'],
    agentDesktop: {
      async execute(request) {
        calls.push({ command: request.command, args: request.args ?? [] })
        return {
          content: [{ type: 'text', text: `DESKTOP_OK:${request.command}:${(request.args ?? []).join(',')}` }],
        }
      },
      async cleanup() {},
    },
  }
}

function makeInMemoryLock(): {
  ops: ComputerUseLockOps
  getHolder: () => symbol | undefined
  acquireCount: () => number
  releaseCount: () => number
} {
  let holder: symbol | undefined
  let acquires = 0
  let releases = 0
  return {
    ops: {
      async check() {
        if (!holder) return { kind: 'free' }
        return { kind: 'held_by_self' }
      },
      async tryAcquire(turn?: symbol) {
        if (holder && holder !== turn) return { kind: 'blocked', by: 'other-session' }
        const fresh = !holder
        holder = turn ?? Symbol('lock')
        if (fresh) acquires++
        return { kind: 'acquired', fresh }
      },
      async release(turn?: symbol) {
        if (!holder || (turn !== undefined && holder !== turn)) return false
        holder = undefined
        releases++
        return true
      },
    },
    getHolder: () => holder,
    acquireCount: () => acquires,
    releaseCount: () => releases,
  }
}

async function mcpPost(
  url: string,
  token: string,
  body: Record<string, unknown>,
  mcpSessionId?: string,
): Promise<{ status: number; sessionId: string | null; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) as Record<string, unknown> : {}
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), json }
}

describe('antigravityComputerUseBridge', () => {
  const bridges: AntigravityComputerUseBridge[] = []

  afterEach(async () => {
    while (bridges.length > 0) {
      await bridges.pop()!.close()
    }
    resetAntigravityComputerUseBridgeLockForTests()
  })

  test('returns null and does not bind a server when Computer Use is disabled', async () => {
    const bridge = await createAntigravityComputerUseBridge('session-disabled', {
      isEnabled: () => false,
      adapter: makeFakeMacAdapter([]),
    })
    expect(bridge).toBeNull()
  })

  test('exposes loopback Streamable HTTP MCP with auth, server/discover fallback, ListTools, and real CallTool dispatch', async () => {
    const replCalls: Array<{ code: string; timeoutMs: number }> = []
    let enabled = true
    const lock = makeInMemoryLock()
    const bridge = await createAntigravityComputerUseBridge('session-mac-1', {
      isEnabled: () => enabled,
      adapter: makeFakeMacAdapter(replCalls),
      coordinateMode: 'pixels',
      platform: 'darwin',
      lockOps: lock.ops,
    })
    expect(bridge).not.toBeNull()
    bridges.push(bridge!)

    expect(bridge!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(bridge!.mcpServerConfig).toEqual({
      type: 'http',
      name: ANTIGRAVITY_COMPUTER_USE_SERVER_NAME,
      url: bridge!.url,
      headers: [{ name: 'Authorization', value: `Bearer ${bridge!.token}` }],
    })
    expect(bridge!.systemPromptAppend).toContain(ANTIGRAVITY_COMPUTER_USE_SERVER_NAME)
    expect(bridge!.systemPromptAppend).toContain('osascript')

    // Unauthenticated .well-known probe returns 404 (matches agy 1.5.17 behavior)
    const wellKnown = await fetch(bridge!.url.replace('/mcp', '/.well-known/oauth-protected-resource/mcp'))
    expect(wellKnown.status).toBe(404)

    // Missing or invalid Bearer token is rejected with 401
    const unauth = await fetch(bridge!.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(unauth.status).toBe(401)

    // server/discover returns -32601 cleanly so agy falls back to initialize
    const discover = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {},
    })
    expect(discover.status).toBe(200)
    expect((discover.json.error as { code?: number })?.code).toBe(-32601)

    // initialize -> notifications/initialized -> tools/list -> tools/call
    const init = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'antigravity-client', version: '1.0.0' },
      },
    })
    expect(init.status).toBe(200)
    expect(init.sessionId).toBeTruthy()
    const sid = init.sessionId!

    const initialized = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }, sid)
    expect(initialized.status).toBe(202)

    const list = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    }, sid)
    const tools = ((list.json.result as { tools?: Array<{ name: string }> })?.tools ?? []).map(t => t.name)
    expect(tools).toEqual(['js', 'js_reset'])

    const call = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'js', arguments: { code: 'return 1 + 1' } },
    }, sid)
    expect(call.status).toBe(200)
    const callResult = call.json.result as { isError?: boolean; content?: Array<{ text?: string }> }
    expect(callResult.isError).not.toBe(true)
    expect(callResult.content?.[0]?.text).toBe('REPL_OK:return 1 + 1')
    expect(replCalls).toEqual([{ code: 'return 1 + 1', timeoutMs: 30000 }])

    // Disabling Computer Use mid-session hides tools and blocks further calls
    enabled = false
    expect(bridge!.isEnabled()).toBe(false)
    const listDisabled = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/list',
      params: {},
    }, sid)
    expect((listDisabled.json.result as { tools?: unknown[] })?.tools).toEqual([])

    const callDisabled = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'js', arguments: { code: 'return 2 + 2' } },
    }, sid)
    expect((callDisabled.json.result as { isError?: boolean })?.isError).toBe(true)
    expect(replCalls).toHaveLength(1)
  })

  test('enforces global lock exclusivity across bridges, turn abort, and lock release', async () => {
    const callsA: Array<{ command: string; args: string[] }> = []
    const callsB: Array<{ command: string; args: string[] }> = []
    const lock = makeInMemoryLock()

    const bridgeA = await createAntigravityComputerUseBridge('session-a', {
      isEnabled: () => true,
      adapter: makeFakeAgentDesktopAdapter(callsA),
      coordinateMode: 'pixels',
      platform: 'linux',
      lockOps: lock.ops,
    })
    const bridgeB = await createAntigravityComputerUseBridge('session-b', {
      isEnabled: () => true,
      adapter: makeFakeAgentDesktopAdapter(callsB),
      coordinateMode: 'pixels',
      platform: 'linux',
      lockOps: lock.ops,
    })
    bridges.push(bridgeA!, bridgeB!)

    const initA = await mcpPost(bridgeA!.url, bridgeA!.token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    })
    const initB = await mcpPost(bridgeB!.url, bridgeB!.token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    })

    // Session A acquires lock and executes
    const resA = await mcpPost(bridgeA!.url, bridgeA!.token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:e1'] } },
    }, initA.sessionId!)
    expect((resA.json.result as { isError?: boolean })?.isError).not.toBe(true)
    expect(callsA).toHaveLength(1)
    expect(lock.acquireCount()).toBe(1)

    // Session B is blocked while Session A holds the lock
    const resBBlocked = await mcpPost(bridgeB!.url, bridgeB!.token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:e2'] } },
    }, initB.sessionId!)
    expect((resBBlocked.json.result as { isError?: boolean })?.isError).toBe(true)
    expect(callsB).toHaveLength(0)

    // Releasing Session A's lock lets Session B proceed
    await bridgeA!.releaseLock()
    expect(lock.releaseCount()).toBe(1)

    const resBAllowed = await mcpPost(bridgeB!.url, bridgeB!.token, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:e2'] } },
    }, initB.sessionId!)
    expect((resBAllowed.json.result as { isError?: boolean })?.isError).not.toBe(true)
    expect(callsB).toHaveLength(1)

    // Aborting turn cancels subsequent dispatch until reset
    bridgeB!.abortCurrentTurn()
    const resBAborted = await mcpPost(bridgeB!.url, bridgeB!.token, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:e3'] } },
    }, initB.sessionId!)
    expect((resBAborted.json.result as { isError?: boolean })?.isError).toBe(true)
    expect(callsB).toHaveLength(1)

    bridgeB!.resetTurnAbort()
    const resBResumed = await mcpPost(bridgeB!.url, bridgeB!.token, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:e3'] } },
    }, initB.sessionId!)
    expect((resBResumed.json.result as { isError?: boolean })?.isError).not.toBe(true)
    expect(callsB).toHaveLength(2)
  })

  test('matches only our injected Computer Use MCP server tool names and builds platform prompts', () => {
    expect(isAntigravityComputerUseToolName('mcp_cc-haha-computer-use_js')).toBe(true)
    expect(isAntigravityComputerUseToolName('mcp_cc_haha_computer_use_js')).toBe(true)
    expect(isAntigravityComputerUseToolName('mcp_cc-haha-computer-use_js_reset')).toBe(true)
    expect(isAntigravityComputerUseToolName('mcp_cc-haha-computer-use_desktop')).toBe(true)
    expect(isAntigravityComputerUseToolName('mcp__cc-haha-computer-use__screenshot')).toBe(true)
    expect(isAntigravityComputerUseToolName('mcp_cc-haha-computer-use_left_click')).toBe(true)
    expect(isAntigravityComputerUseToolName('mcp_cc-haha-computer-use_teach_step')).toBe(true)
    // Reject arbitrary server suffixes and unknown tool names
    expect(isAntigravityComputerUseToolName('mcp_cc-haha-computer-use-helper_exec')).toBe(false)
    expect(isAntigravityComputerUseToolName('mcp_cc-haha-computer-use-helper_js')).toBe(false)
    expect(isAntigravityComputerUseToolName('mcp_cc-haha-computer-use_exec')).toBe(false)
    expect(isAntigravityComputerUseToolName('mcp_cc-haha-computer-use_helper_js')).toBe(false)
    expect(isAntigravityComputerUseToolName('mcp_other_server_js')).toBe(false)
    expect(isAntigravityComputerUseToolName('run_command')).toBe(false)
    expect(isAntigravityComputerUseToolName(undefined)).toBe(false)

    expect(buildAntigravityComputerUsePrompt('darwin')).toContain('cua.getApp')
    expect(buildAntigravityComputerUsePrompt('linux')).toContain('desktop({command')
  })

  test('prevents same-process concurrent lock reentrancy race and rolls back on blocked/error/cancel', async () => {
    const callsA: Array<{ command: string; args: string[] }> = []
    const callsB: Array<{ command: string; args: string[] }> = []
    // Simulate real tryAcquireComputerUseLock PID-based ownedByThisProcess reentrancy:
    // after an async tick, a second caller in the same process gets { kind: 'acquired', fresh: false }!
    let processHeld = false
    let mode: 'normal' | 'blocked' | 'throw' | 'cancel' = 'normal'
    let onTryAcquireStart: (() => void) | undefined
    const reentrantLockOps: ComputerUseLockOps = {
      async check() {
        return processHeld ? { kind: 'held_by_self' } : { kind: 'free' }
      },
      async tryAcquire() {
        onTryAcquireStart?.()
        await new Promise(resolve => setTimeout(resolve, 25))
        if (mode === 'blocked') return { kind: 'blocked', by: 'external-proc' }
        if (mode === 'throw') throw new Error('lock-io-failure')
        const fresh = !processHeld
        processHeld = true
        return { kind: 'acquired', fresh }
      },
      async release() {
        processHeld = false
        return true
      },
    }

    const bridgeA = await createAntigravityComputerUseBridge('session-race-a', {
      isEnabled: () => true,
      adapter: makeFakeAgentDesktopAdapter(callsA),
      coordinateMode: 'pixels',
      platform: 'linux',
      lockOps: reentrantLockOps,
    })
    const bridgeB = await createAntigravityComputerUseBridge('session-race-b', {
      isEnabled: () => true,
      adapter: makeFakeAgentDesktopAdapter(callsB),
      coordinateMode: 'pixels',
      platform: 'linux',
      lockOps: reentrantLockOps,
    })
    bridges.push(bridgeA!, bridgeB!)

    const initA = await mcpPost(bridgeA!.url, bridgeA!.token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    })
    const initB = await mcpPost(bridgeB!.url, bridgeB!.token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    })

    // Fire two concurrent tools/call requests in the same process: only one may succeed
    const [resA, resB] = await Promise.all([
      mcpPost(bridgeA!.url, bridgeA!.token, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'desktop', arguments: { command: 'click', args: ['@s:a'] } },
      }, initA.sessionId!),
      mcpPost(bridgeB!.url, bridgeB!.token, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'desktop', arguments: { command: 'click', args: ['@s:b'] } },
      }, initB.sessionId!),
    ])
    const okA = (resA.json.result as { isError?: boolean })?.isError !== true
    const okB = (resB.json.result as { isError?: boolean })?.isError !== true
    expect(Number(okA) + Number(okB)).toBe(1)
    expect(callsA.length + callsB.length).toBe(1)

    await bridgeA!.releaseLock()
    await bridgeB!.releaseLock()

    // Rollback on blocked -> subsequent session can acquire
    mode = 'blocked'
    const blockedRes = await mcpPost(bridgeA!.url, bridgeA!.token, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:c'] } },
    }, initA.sessionId!)
    expect((blockedRes.json.result as { isError?: boolean })?.isError).toBe(true)

    mode = 'normal'
    const afterBlockedB = await mcpPost(bridgeB!.url, bridgeB!.token, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:d'] } },
    }, initB.sessionId!)
    expect((afterBlockedB.json.result as { isError?: boolean })?.isError).not.toBe(true)
    await bridgeB!.releaseLock()

    // Rollback on tryAcquire throw -> subsequent session can acquire
    mode = 'throw'
    const throwRes = await mcpPost(bridgeA!.url, bridgeA!.token, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:e'] } },
    }, initA.sessionId!)
    expect((throwRes.json.result as { isError?: boolean })?.isError).toBe(true)

    mode = 'normal'
    const afterThrowB = await mcpPost(bridgeB!.url, bridgeB!.token, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:f'] } },
    }, initB.sessionId!)
    expect((afterThrowB.json.result as { isError?: boolean })?.isError).not.toBe(true)
    await bridgeB!.releaseLock()

    // Rollback on cancel during tryAcquire -> subsequent session can acquire
    onTryAcquireStart = () => {
      bridgeA!.abortCurrentTurn()
    }
    const cancelRes = await mcpPost(bridgeA!.url, bridgeA!.token, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:g'] } },
    }, initA.sessionId!)
    onTryAcquireStart = undefined
    expect((cancelRes.json.result as { isError?: boolean })?.isError).toBe(true)

    const afterCancelB = await mcpPost(bridgeB!.url, bridgeB!.token, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'desktop', arguments: { command: 'click', args: ['@s:h'] } },
    }, initB.sessionId!)
    expect((afterCancelB.json.result as { isError?: boolean })?.isError).not.toBe(true)
  })

  test('rejects unknown mcp-session-id with 404 before server allocation and cleans up uninitialized ephemeral transports', async () => {
    let adapterDisabledChecks = 0
    const baseAdapter = makeFakeMacAdapter([])
    const trackedAdapter: ComputerUseHostAdapter = {
      ...baseAdapter,
      isDisabled: () => {
        adapterDisabledChecks++
        return false
      },
    }
    const bridge = await createAntigravityComputerUseBridge('session-http-guard', {
      isEnabled: () => true,
      adapter: trackedAdapter,
      coordinateMode: 'pixels',
      platform: 'darwin',
      lockOps: makeInMemoryLock().ops,
    })
    bridges.push(bridge!)

    // Unknown mcp-session-id is rejected with 404 before allocating any Server/Transport
    const checksBefore = adapterDisabledChecks
    const unknownRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }, 'non-existent-session-id')
    expect(unknownRes.status).toBe(404)
    expect((unknownRes.json.error as { code?: number })?.code).toBe(-32001)
    expect(adapterDisabledChecks).toBe(checksBefore)

    // Non-initialize request without mcp-session-id completes cleanly without leaking an initialized session
    const badPost = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })
    expect(badPost.status).toBe(400)
    expect(badPost.sessionId).toBeNull()

    // Subsequent valid initialize still succeeds cleanly
    const init = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    })
    expect(init.status).toBe(200)
    expect(init.sessionId).toBeTruthy()
  })
})
