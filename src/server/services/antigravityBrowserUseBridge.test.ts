import { afterEach, describe, expect, test } from 'bun:test'
import {
  ANTIGRAVITY_BROWSER_USE_SERVER_NAME,
  buildAntigravityBrowserUsePrompt,
  createAntigravityBrowserUseBridge,
  estimateAntigravityBrowserUseTokens,
  isAntigravityBrowserUseToolName,
  resolveAntigravityBrowserUseToolName,
  type AntigravityBrowserUseBridge,
  type AntigravityBrowserUseServiceLike,
} from './antigravityBrowserUseBridge.js'

const SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

type RecordedCall = {
  method: string
  input: Record<string, unknown>
}

function makeFakeBrowserService(
  calls: RecordedCall[],
  overrides: Partial<AntigravityBrowserUseServiceLike> = {},
): AntigravityBrowserUseServiceLike {
  return {
    async executeTabs(input) {
      calls.push({ method: 'executeTabs', input: { ...input } })
      return { target: input.target ?? 'workspace', tabs: [{ tabId: 'tab-1', url: 'https://example.test' }] }
    },
    async executeNavigate(input) {
      calls.push({ method: 'executeNavigate', input: { ...input } })
      return {
        tabId: input.tabId ?? 'tab-1',
        target: input.target === 'chrome' ? 'chrome' : 'workspace',
        url: input.url ?? 'https://example.test',
        title: 'Example',
      } as never
    },
    async executeSnapshot(input) {
      calls.push({ method: 'executeSnapshot', input: { ...input } })
      return {
        tabId: input.tabId ?? 'tab-1',
        target: input.target === 'chrome' ? 'chrome' : 'workspace',
        url: 'https://example.test',
        title: 'Example',
        snapshot: '[page] Example (@e1 button "Go")',
        ...(input.screenshot
          ? { screenshotDataUrl: `data:image/png;base64,${SAMPLE_PNG_BASE64}` }
          : {}),
      } as never
    },
    async executeAct(input) {
      calls.push({ method: 'executeAct', input: { ...input } })
      return {
        tabId: input.tabId ?? 'tab-1',
        target: input.target === 'chrome' ? 'chrome' : 'workspace',
        executed: input.steps.length,
        stoppedReason: 'completed',
      } as never
    },
    async executeInspect(input) {
      calls.push({ method: 'executeInspect', input: { ...input } })
      return {
        tabId: input.tabId ?? 'tab-1',
        target: input.target === 'chrome' ? 'chrome' : 'workspace',
        kind: input.kind,
        data: 'hello',
      } as never
    },
    async executeTakeover(input) {
      calls.push({ method: 'executeTakeover', input: { ...input } })
      return {
        takeoverId: 'tk-1',
        sessionId: input.sessionId,
        tabId: input.tabId ?? 'tab-1',
        target: input.target === 'chrome' ? 'chrome' : 'workspace',
        status: 'pending',
        reason: input.reason,
        message: input.message,
        createdAt: '2026-11-27T00:00:00.000Z',
      }
    },
    async cleanupAfterTurn(input) {
      calls.push({ method: 'cleanupAfterTurn', input: { ...input } })
      return { ok: true, preservedTakeover: false }
    },
    hasPendingTakeover: () => false,
    ...overrides,
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
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id'),
    json,
  }
}

async function initMcpSession(bridge: AntigravityBrowserUseBridge): Promise<string> {
  const initRes = await mcpPost(bridge.url, bridge.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agy-test', version: '1.0.0' },
    },
  })
  expect(initRes.status).toBe(200)
  expect(initRes.sessionId).toBeTruthy()
  return initRes.sessionId!
}

describe('antigravityBrowserUseBridge', () => {
  const bridges: AntigravityBrowserUseBridge[] = []

  afterEach(async () => {
    while (bridges.length > 0) {
      const b = bridges.pop()!
      await b.close()
    }
  })

  test('returns null when Browser Use is disabled in Settings', async () => {
    const bridge = await createAntigravityBrowserUseBridge('sess-disabled', {
      isEnabled: () => false,
      service: makeFakeBrowserService([]),
    })
    expect(bridge).toBeNull()
  })

  test('resolves and validates Antigravity Browser Use MCP tool names strictly', () => {
    expect(resolveAntigravityBrowserUseToolName('mcp_cc-haha-browser-use_BrowserSnapshot')).toBe('BrowserSnapshot')
    expect(resolveAntigravityBrowserUseToolName('mcp_cc-haha-browser-use_browsersnapshot')).toBe('BrowserSnapshot')
    expect(resolveAntigravityBrowserUseToolName('mcp__cc_haha_browser_use__BrowserAct')).toBe('BrowserAct')
    expect(resolveAntigravityBrowserUseToolName('mcp_cc-haha-browser-use_BrowserTabs')).toBe('BrowserTabs')
    expect(resolveAntigravityBrowserUseToolName('mcp_cc-haha-browser-use_BrowserNavigate')).toBe('BrowserNavigate')
    expect(resolveAntigravityBrowserUseToolName('mcp_cc-haha-browser-use_BrowserInspect')).toBe('BrowserInspect')
    expect(resolveAntigravityBrowserUseToolName('mcp_cc-haha-browser-use_BrowserTakeover')).toBe('BrowserTakeover')
    expect(isAntigravityBrowserUseToolName('mcp_cc-haha-browser-use_BrowserNavigate')).toBe(true)

    expect(resolveAntigravityBrowserUseToolName('mcp_cc-haha-browser-use_UnknownTool')).toBeUndefined()
    expect(resolveAntigravityBrowserUseToolName('mcp_cc-haha-computer-use_js')).toBeUndefined()
    expect(resolveAntigravityBrowserUseToolName('BrowserSnapshot')).toBeUndefined()
    expect(isAntigravityBrowserUseToolName(undefined)).toBe(false)
  })

  test('enforces loopback auth, agy compatibility probes, and exposes all 6 Browser Use tools', async () => {
    const calls: RecordedCall[] = []
    const bridge = await createAntigravityBrowserUseBridge('sess-list', {
      isEnabled: () => true,
      service: makeFakeBrowserService(calls),
    })
    expect(bridge).not.toBeNull()
    bridges.push(bridge!)

    expect(bridge!.serverName).toBe(ANTIGRAVITY_BROWSER_USE_SERVER_NAME)
    expect(bridge!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(bridge!.mcpServerConfig).toEqual({
      type: 'http',
      name: ANTIGRAVITY_BROWSER_USE_SERVER_NAME,
      url: bridge!.url,
      headers: [{ name: 'Authorization', value: `Bearer ${bridge!.token}` }],
    })

    // Unauthenticated /.well-known/* returns 404; /mcp rejects missing or wrong token
    const baseUrl = bridge!.url.replace(/\/mcp$/, '')
    const wellKnown = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
    expect(wellKnown.status).toBe(404)
    const noAuth = await fetch(bridge!.url, { method: 'POST', body: '{}' })
    expect(noAuth.status).toBe(401)
    const badAuth = await fetch(bridge!.url, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
      body: '{}',
    })
    expect(badAuth.status).toBe(401)

    // agy server/discover returns -32601 cleanly
    const discover = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 99,
      method: 'server/discover',
      params: {},
    })
    expect(discover.status).toBe(200)
    expect(discover.json.error).toEqual({ code: -32601, message: 'Method not found' })

    const mcpSessionId = await initMcpSession(bridge!)
    const listRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }, mcpSessionId)
    expect(listRes.status).toBe(200)
    const tools = (listRes.json.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }> }).tools
    expect(tools.map(tool => tool.name)).toEqual([
      'BrowserTabs',
      'BrowserNavigate',
      'BrowserSnapshot',
      'BrowserAct',
      'BrowserInspect',
      'BrowserTakeover',
    ])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.$schema).toBeUndefined()
    }
    expect(tools.find(tool => tool.name === 'BrowserSnapshot')?.annotations?.readOnlyHint).toBe(true)

    const prompt = buildAntigravityBrowserUsePrompt()
    expect(prompt).toContain(ANTIGRAVITY_BROWSER_USE_SERVER_NAME)
    expect(prompt).toContain('Workspace Browser')
    expect(prompt).toContain('BrowserTakeover')
    expect(estimateAntigravityBrowserUseTokens(bridge!)).toBeGreaterThan(200)
  })

  test('routes all 6 tools to BrowserUseService, splits screenshot data URLs into MCP image blocks, and annotates takeover pause guidance', async () => {
    const calls: RecordedCall[] = []
    const bridge = await createAntigravityBrowserUseBridge('sess-exec', {
      isEnabled: () => true,
      service: makeFakeBrowserService(calls, {
        async executeAct(input) {
          calls.push({ method: 'executeAct', input: { ...input } })
          return {
            tabId: 'tab-1',
            target: 'workspace',
            executed: 1,
            stoppedReason: 'sensitive_gate',
            takeover: {
              takeoverId: 'tk-act',
              status: 'pending',
              reason: 'captcha',
              message: 'Solve CAPTCHA',
            },
          } as never
        },
      }),
    })
    expect(bridge).not.toBeNull()
    bridges.push(bridge!)

    const mcpSessionId = await initMcpSession(bridge!)

    // 1. BrowserTabs
    const tabsRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'BrowserTabs', arguments: { action: 'list', target: 'workspace' } },
    }, mcpSessionId)
    expect((tabsRes.json.result as { isError?: boolean }).isError).toBeUndefined()

    // 2. BrowserNavigate
    const navRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'BrowserNavigate', arguments: { url: 'https://example.test', target: 'chrome' } },
    }, mcpSessionId)
    expect((navRes.json.result as { isError?: boolean }).isError).toBeUndefined()

    // 3. BrowserSnapshot with screenshot -> text block (no dataUrl) + MCP image block
    const snapRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'BrowserSnapshot', arguments: { screenshot: true } },
    }, mcpSessionId)
    const snapContent = (snapRes.json.result as { content: Array<Record<string, unknown>> }).content
    expect(snapContent).toHaveLength(2)
    const snapTextJson = JSON.parse(String(snapContent[0]!.text)) as Record<string, unknown>
    expect(snapTextJson.screenshotAttached).toBe(true)
    expect(snapTextJson.screenshotDataUrl).toBeUndefined()
    expect(snapContent[1]).toEqual({
      type: 'image',
      data: SAMPLE_PNG_BASE64,
      mimeType: 'image/png',
    })

    // 4. BrowserAct with sensitive_gate takeover -> adds _nextStep pause guidance
    const actRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'BrowserAct',
        arguments: { steps: [{ action: 'click', ref: '@e1', label: 'Verify' }] },
      },
    }, mcpSessionId)
    const actText = JSON.parse(String((actRes.json.result as { content: Array<{ text: string }> }).content[0]!.text)) as Record<string, unknown>
    expect(actText.stoppedReason).toBe('sensitive_gate')
    expect(String(actText._nextStep)).toContain('Stop calling browser tools immediately')

    // 5. BrowserInspect
    const inspectRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'BrowserInspect', arguments: { kind: 'text' } },
    }, mcpSessionId)
    expect((inspectRes.json.result as { isError?: boolean }).isError).toBeUndefined()

    // 6. BrowserTakeover -> adds _nextStep pause guidance
    const takeoverRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'BrowserTakeover', arguments: { reason: 'login', message: 'Please sign in' } },
    }, mcpSessionId)
    const tkText = JSON.parse(String((takeoverRes.json.result as { content: Array<{ text: string }> }).content[0]!.text)) as Record<string, unknown>
    expect(tkText.status).toBe('pending')
    expect(String(tkText._nextStep)).toContain('Resume')

    // Verify all 6 methods received the exact sessionId & antigravity agentId
    expect(calls.map(c => c.method)).toEqual([
      'executeTabs',
      'executeNavigate',
      'executeSnapshot',
      'executeAct',
      'executeInspect',
      'executeTakeover',
    ])
    for (const call of calls) {
      expect(call.input.sessionId).toBe('sess-exec')
      expect(call.input.agentId).toBe('antigravity:sess-exec')
    }
  })

  test('handles validation errors, live mid-session disable kill-switch, abort/reset, and cleanupAfterTurn on close', async () => {
    const calls: RecordedCall[] = []
    let enabled = true
    const bridge = await createAntigravityBrowserUseBridge('sess-gates', {
      isEnabled: () => enabled,
      service: makeFakeBrowserService(calls),
    })
    expect(bridge).not.toBeNull()
    bridges.push(bridge!)

    const mcpSessionId = await initMcpSession(bridge!)

    // Invalid schema arguments return isError: true without calling service
    const invalidRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'BrowserTabs', arguments: { action: 'invalid_action' } },
    }, mcpSessionId)
    expect((invalidRes.json.result as { isError?: boolean }).isError).toBe(true)
    expect(calls).toHaveLength(0)

    // Turn abort blocks calls until resetTurnAbort
    bridge!.abortCurrentTurn()
    const abortedRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'BrowserTabs', arguments: { action: 'list' } },
    }, mcpSessionId)
    expect((abortedRes.json.result as { isError?: boolean }).isError).toBe(true)

    bridge!.resetTurnAbort()
    const okRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'BrowserTabs', arguments: { action: 'list' } },
    }, mcpSessionId)
    expect((okRes.json.result as { isError?: boolean }).isError).toBeUndefined()

    // Live mid-session kill-switch: disabling Settings hides tools & rejects calls
    enabled = false
    expect(bridge!.isEnabled()).toBe(false)
    const emptyList = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/list',
      params: {},
    }, mcpSessionId)
    expect((emptyList.json.result as { tools: unknown[] }).tools).toEqual([])

    const disabledCall = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: { name: 'BrowserTabs', arguments: { action: 'list' } },
    }, mcpSessionId)
    expect((disabledCall.json.result as { isError?: boolean }).isError).toBe(true)

    // First cleanup releases the lease acquired by BrowserTabs(list); subsequent untouched turn skips redundant IPC
    await bridge!.cleanupAfterTurn()
    const cleanupCallsAfterRelease = calls.filter(c => c.method === 'cleanupAfterTurn').length
    expect(cleanupCallsAfterRelease).toBe(1)
    bridge!.resetTurnAbort()
    await bridge!.cleanupAfterTurn()
    expect(calls.filter(c => c.method === 'cleanupAfterTurn')).toHaveLength(cleanupCallsAfterRelease)

    // Closing triggers cleanupAfterTurn because the session used browser tools earlier
    await bridge!.close()
    bridges.pop()
    expect(calls.filter(c => c.method === 'cleanupAfterTurn').length).toBeGreaterThan(cleanupCallsAfterRelease)
  })

  test('blocks all browser MCP tools while session takeover is pending, serializes cleanup before next tool call, preserves lease tracking after preservedTakeover, and awaits concurrent close()', async () => {
    const calls: RecordedCall[] = []
    const events: string[] = []
    let pendingTakeover = false
    let preserveNextCleanup = true
    let releaseSlowCleanup: (() => void) | null = null
    let releaseCloseCleanup: (() => void) | null = null

    const bridge = await createAntigravityBrowserUseBridge('sess-hardening', {
      isEnabled: () => true,
      service: makeFakeBrowserService(calls, {
        hasPendingTakeover: () => pendingTakeover,
        async executeSnapshot(input) {
          events.push('snapshot')
          calls.push({ method: 'executeSnapshot', input: { ...input } })
          return {
            tabId: 'tab-1',
            target: 'workspace',
            url: 'https://example.test',
            title: 'Example',
            snapshot: 'ok',
          } as never
        },
        async cleanupAfterTurn(input) {
          events.push('cleanup-start')
          calls.push({ method: 'cleanupAfterTurn', input: { ...input } })
          if (releaseSlowCleanup === null && events.filter(e => e === 'cleanup-start').length === 2) {
            await new Promise<void>(resolve => { releaseSlowCleanup = resolve })
          }
          if (releaseCloseCleanup === null && events.filter(e => e === 'cleanup-start').length === 3) {
            await new Promise<void>(resolve => { releaseCloseCleanup = resolve })
          }
          events.push('cleanup-end')
          const preserved = preserveNextCleanup
          preserveNextCleanup = false
          return { ok: true, preservedTakeover: preserved }
        },
      }),
    })
    expect(bridge).not.toBeNull()
    bridges.push(bridge!)

    const mcpSessionId = await initMcpSession(bridge!)

    // 1. Invalid args do not mark the turn touched -> cleanupAfterTurn stays a no-op
    const invalidRes = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'BrowserTabs', arguments: { action: 'nope' } },
    }, mcpSessionId)
    expect((invalidRes.json.result as { isError?: boolean }).isError).toBe(true)
    await bridge!.cleanupAfterTurn()
    expect(calls.filter(c => c.method === 'cleanupAfterTurn')).toHaveLength(0)

    // 2. Pending takeover blocks BrowserSnapshot, BrowserInspect, and BrowserTabs(open)
    pendingTakeover = true
    for (const [id, name, args] of [
      [31, 'BrowserSnapshot', {}],
      [32, 'BrowserInspect', { kind: 'text' }],
      [33, 'BrowserTabs', { action: 'open', url: 'https://bypass.test' }],
    ] as const) {
      const blocked = await mcpPost(bridge!.url, bridge!.token, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }, mcpSessionId)
      expect((blocked.json.result as { isError?: boolean }).isError).toBe(true)
    }
    expect(calls).toHaveLength(0)

    // 3. After takeover resumes, tool runs; cleanup #1 returns preservedTakeover: true so next text-only turn still cleans up
    pendingTakeover = false
    const snap1 = await mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: { name: 'BrowserSnapshot', arguments: {} },
    }, mcpSessionId)
    expect((snap1.json.result as { isError?: boolean }).isError).toBeUndefined()
    await bridge!.cleanupAfterTurn()
    expect(calls.filter(c => c.method === 'cleanupAfterTurn')).toHaveLength(1)

    // 4. On next turn (no browser tool called yet), cleanup #2 still runs because cleanup #1 preservedTakeover;
    //    a concurrent BrowserSnapshot must wait for cleanup #2 to finish first!
    bridge!.resetTurnAbort()
    const slowCleanupPromise = bridge!.cleanupAfterTurn()
    while (!releaseSlowCleanup) await new Promise(r => setTimeout(r, 5))
    const snap2Promise = mcpPost(bridge!.url, bridge!.token, {
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: { name: 'BrowserSnapshot', arguments: {} },
    }, mcpSessionId)
    await new Promise(r => setTimeout(r, 20))
    expect(events.filter(e => e === 'snapshot')).toHaveLength(1)
    releaseSlowCleanup()
    await slowCleanupPromise
    await snap2Promise
    const cleanup2EndIdx = events.lastIndexOf('cleanup-end')
    const snap2Idx = events.lastIndexOf('snapshot')
    expect(cleanup2EndIdx).toBeGreaterThan(-1)
    expect(snap2Idx).toBeGreaterThan(cleanup2EndIdx)

    // 5. Concurrent bridge.close() calls both wait for the same shutdown promise
    const close1 = bridge!.close()
    while (!releaseCloseCleanup) await new Promise(r => setTimeout(r, 5))
    let close2Settled = false
    const close2 = bridge!.close().then(() => { close2Settled = true })
    await new Promise(r => setTimeout(r, 20))
    expect(close2Settled).toBe(false)
    releaseCloseCleanup()
    await Promise.all([close1, close2])
    expect(close2Settled).toBe(true)
    bridges.pop()
  })
})
