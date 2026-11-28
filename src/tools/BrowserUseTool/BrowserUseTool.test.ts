import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'
import { z } from 'zod/v4'

import { useMergedTools } from '../../hooks/useMergedTools.js'
import { toGeminiParametersSchema } from '../../server/proxy/transform/geminiJsonSchema.js'
import {
  invalidateBrowserUseConfigCache,
  saveBrowserUseConfig,
} from '../../services/browserUse/config.js'
import type {
  CdpEventListener,
  CdpTransport,
  ChromeConnectionManager,
  ChromeConnectionState,
} from '../../services/browserUse/index.js'
import { getEmptyToolPermissionContext, type Tools } from '../../Tool.js'
import { getAgentProfile, setAgentProfile } from '../../utils/agentProfile.js'
import { runCleanupFunctions } from '../../utils/cleanupRegistry.js'
import { consumeUserDecisionTurnPause } from '../../utils/userDecisionTurnBoundary.js'
import {
  callBrowserUseBridge,
  cleanupBrowserUseAfterTurn,
  clearBrowserUseTakeoverPending,
  isBrowserUseBridgeDesktopMode,
  resetBrowserUseBridgeStateForTests,
  setStandaloneChromeManagerFactoryForTests,
} from './bridge.js'
import {
  BrowserActTool,
  BrowserInspectTool,
  BrowserNavigateTool,
  BrowserSnapshotTool,
  BrowserTabsTool,
  BrowserTakeoverTool,
  browserUseTools,
  isBrowserUseToolName,
} from './index.js'

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CC_HAHA_DESKTOP_SERVER_URL',
  'CC_HAHA_SESSION_COLLABORATION_TOKEN',
  'CC_HAHA_SESSION_ID',
] as const

const savedEnv = new Map<string, string | undefined>()
const savedProfile = getAgentProfile()
let tempConfigDir: string | null = null
const originalFetch = globalThis.fetch

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
  }
  tempConfigDir = mkdtempSync(join(tmpdir(), 'cc-haha-browser-use-tool-'))
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  setAgentProfile('standard')
  invalidateBrowserUseConfigCache()
  resetBrowserUseBridgeStateForTests()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setAgentProfile(savedProfile)
  invalidateBrowserUseConfigCache()
  resetBrowserUseBridgeStateForTests()
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempConfigDir) {
    rmSync(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = null
  }
})

function hasForbiddenSchemaKeywords(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasForbiddenSchemaKeywords)
  }
  if (!node || typeof node !== 'object') {
    return false
  }
  const obj = node as Record<string, unknown>
  if ('oneOf' in obj || 'anyOf' in obj || '$ref' in obj) {
    return true
  }
  return Object.values(obj).some(hasForbiddenSchemaKeywords)
}

describe('BrowserUseTool definitions and schemas', () => {
  test('registers 6 compact native tools with flat multi-provider JSON Schemas (no oneOf/anyOf/$ref)', () => {
    expect(browserUseTools.map(tool => tool.name)).toEqual([
      'BrowserTabs',
      'BrowserNavigate',
      'BrowserSnapshot',
      'BrowserAct',
      'BrowserInspect',
      'BrowserTakeover',
    ])
    expect(isBrowserUseToolName('BrowserAct')).toBe(true)
    expect(isBrowserUseToolName('Read')).toBe(false)

    for (const tool of browserUseTools) {
      const jsonSchema = z.toJSONSchema(tool.inputSchema)
      expect(hasForbiddenSchemaKeywords(jsonSchema)).toBe(false)
      const geminiSchema = toGeminiParametersSchema(jsonSchema)
      expect(geminiSchema.type).toBe('object')
      expect(hasForbiddenSchemaKeywords(geminiSchema)).toBe(false)
    }
  })

  test('gates every tool with Browser Use config and excludes lean profile (0 tokens when disabled)', () => {
    // Default fail-closed
    for (const tool of browserUseTools) {
      expect(tool.isEnabled()).toBe(false)
    }

    // Enabled in standard profile
    saveBrowserUseConfig({ enabled: true })
    for (const tool of browserUseTools) {
      expect(tool.isEnabled()).toBe(true)
    }

    // Disabled in lean profile even when config is enabled
    setAgentProfile('lean')
    for (const tool of browserUseTools) {
      expect(tool.isEnabled()).toBe(false)
    }
  })

  test('reports accurate isReadOnly and isConcurrencySafe semantics per tool and input', () => {
    expect(BrowserSnapshotTool.isReadOnly({} as never)).toBe(true)
    expect(BrowserSnapshotTool.isConcurrencySafe({} as never)).toBe(true)

    expect(BrowserTabsTool.isReadOnly({ action: 'list' })).toBe(true)
    expect(BrowserTabsTool.isConcurrencySafe({ action: 'list' })).toBe(true)
    expect(BrowserTabsTool.isReadOnly({ action: 'open', url: 'https://example.com' })).toBe(false)
    expect(BrowserTabsTool.isConcurrencySafe({ action: 'close', tabId: 'tab-1' })).toBe(false)

    expect(BrowserInspectTool.isReadOnly({ kind: 'console' })).toBe(true)
    expect(BrowserInspectTool.isConcurrencySafe({ kind: 'network' })).toBe(true)
    expect(BrowserInspectTool.isReadOnly({ kind: 'eval', expression: '1+1' })).toBe(false)
    expect(BrowserInspectTool.isConcurrencySafe({ kind: 'eval', expression: '1+1' })).toBe(false)

    expect(BrowserNavigateTool.isReadOnly({} as never)).toBe(false)
    expect(BrowserActTool.isReadOnly({} as never)).toBe(false)
    expect(BrowserTakeoverTool.isReadOnly({} as never)).toBe(false)
  })

  test('enforces BrowserAct batch bounds (1..10 steps)', () => {
    expect(BrowserActTool.inputSchema.safeParse({ steps: [] }).success).toBe(false)
    expect(
      BrowserActTool.inputSchema.safeParse({
        steps: Array.from({ length: 11 }, () => ({ action: 'wait', ms: 10 })),
      }).success,
    ).toBe(false)
    expect(
      BrowserActTool.inputSchema.safeParse({
        steps: [
          { action: 'click', ref: '@e1', label: 'Search button' },
          { action: 'fill', ref: '@e2', text: 'hello', clear: true, label: 'Query input' },
        ],
      }).success,
    ).toBe(true)
  })
})

describe('BrowserUseTool desktop bridge execution and turn pause', () => {
  test('posts to /api/browser-use/:action with X-Session-Id + Bearer token and formats screenshots as image blocks', async () => {
    saveBrowserUseConfig({ enabled: true })
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:43210'
    process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'sdk-session-token'
    process.env.CC_HAHA_SESSION_ID = 'sess-browser-1'

    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(url),
        headers: {
          authorization: headers.get('authorization') ?? '',
          sessionId: headers.get('x-session-id') ?? '',
        },
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return Response.json({
        tabId: 'tab-1',
        target: 'workspace',
        url: 'https://example.com',
        title: 'Example',
        treeText: '@e1 button "Sign in"',
        screenshotDataUrl: 'data:image/jpeg;base64,AAAA',
      })
    }) as typeof fetch

    const controller = new AbortController()
    const res = await BrowserSnapshotTool.call(
      { screenshot: true },
      { abortController: controller, agentId: 'agent-main' } as never,
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      url: 'http://127.0.0.1:43210/api/browser-use/snapshot',
      headers: {
        authorization: 'Bearer sdk-session-token',
        sessionId: 'sess-browser-1',
      },
      body: { screenshot: true, agentId: 'agent-main' },
    })

    const block = BrowserSnapshotTool.mapToolResultToToolResultBlockParam(
      res.data,
      'tool-use-1',
    )
    expect(Array.isArray(block.content)).toBe(true)
    const parts = block.content as Array<Record<string, unknown>>
    expect(parts).toHaveLength(2)
    expect(parts[0]?.type).toBe('text')
    expect(String(parts[0]?.text)).not.toContain('data:image/jpeg;base64')
    expect(parts[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: 'AAAA',
      },
    })
  })

  test('BrowserTakeover pauses the turn via requestUserDecisionTurnPause and preserves pause during turn-end cleanup', async () => {
    saveBrowserUseConfig({ enabled: true })
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:43210'
    process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'sdk-session-token'
    process.env.CC_HAHA_SESSION_ID = 'sess-takeover'

    const actionsCalled: string[] = []
    globalThis.fetch = (async (url) => {
      const action = String(url).split('/').pop()!
      actionsCalled.push(action)
      return Response.json({
        takeoverId: 'tk-1',
        tabId: 'tab-1',
        target: 'workspace',
        reason: 'login',
        message: 'Please sign in to your account',
        status: 'pending',
      })
    }) as typeof fetch

    const controller = new AbortController()
    await BrowserTakeoverTool.call(
      { reason: 'login', message: 'Please sign in to your account' },
      { abortController: controller } as never,
    )

    expect(consumeUserDecisionTurnPause(controller)).toBe(true)
    expect(consumeUserDecisionTurnPause(controller)).toBe(false)

    // Turn-end cleanup MUST NOT clear takeover pause state on the host
    await cleanupBrowserUseAfterTurn({ sessionId: 'sess-takeover' })
    expect(actionsCalled).toEqual(['takeover'])
  })

  test('turn-end cleanup is a zero-fetch fast path on non-browser turns', async () => {
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:43210'
    process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'sdk-session-token'
    process.env.CC_HAHA_SESSION_ID = 'sess-non-browser'

    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return Response.json({ ok: true })
    }) as typeof fetch

    await cleanupBrowserUseAfterTurn({ sessionId: 'sess-non-browser' })
    expect(fetchCount).toBe(0)
  })

  test('covers all 6 tool metadata/call paths, sensitive-gate pause, and desktop bridge error branches', async () => {
    saveBrowserUseConfig({ enabled: true })
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:43210'
    process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'sdk-session-token'
    process.env.CC_HAHA_SESSION_ID = 'sess-all-tools'
    expect(isBrowserUseBridgeDesktopMode()).toBe(true)

    for (const tool of browserUseTools) {
      expect(typeof (await tool.description({} as never, {} as never))).toBe('string')
      expect(typeof (await tool.prompt({} as never))).toBe('string')
      expect(tool.userFacingName({} as never)).toBe(tool.name)
      expect(tool.renderToolUseMessage({} as never, {} as never)).toBeNull()
    }

    const actions: string[] = []
    globalThis.fetch = (async (url) => {
      const action = String(url).split('/').pop()!
      actions.push(action)
      if (action === 'act') {
        return Response.json({
          tabId: 'tab-1',
          target: 'workspace',
          completedSteps: 0,
          totalSteps: 1,
          stoppedReason: 'sensitive_gate',
          takeover: { status: 'pending', takeoverId: 'tk-sens' },
          results: [],
        })
      }
      if (action === 'snapshot') {
        return Response.json({
          tabId: 'tab-1',
          screenshotDataUrl: 'not-a-valid-data-url',
        })
      }
      return Response.json({ ok: true, action })
    }) as typeof fetch

    const ctx = () => ({ abortController: new AbortController(), agentId: 'sub-a' } as never)

    const tabsRes = await BrowserTabsTool.call({ action: 'list' }, ctx())
    expect(BrowserTabsTool.mapToolResultToToolResultBlockParam(tabsRes.data, 't1')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
    })

    const navRes = await BrowserNavigateTool.call({ url: 'https://example.com' }, ctx())
    expect(BrowserNavigateTool.mapToolResultToToolResultBlockParam(navRes.data, 't2')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't2',
    })

    const snapRes = await BrowserSnapshotTool.call({}, ctx())
    const snapBlock = BrowserSnapshotTool.mapToolResultToToolResultBlockParam(snapRes.data, 't3')
    expect(typeof snapBlock.content).toBe('string')

    const inspectRes = await BrowserInspectTool.call({ kind: 'console' }, ctx())
    expect(BrowserInspectTool.mapToolResultToToolResultBlockParam(inspectRes.data, 't4')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't4',
    })

    // Non-takeover turn cleanup hits POST /api/browser-use/cleanup
    await cleanupBrowserUseAfterTurn({ sessionId: 'sess-all-tools', agentId: 'sub-a' })
    expect(actions).toContain('cleanup')

    // BrowserAct returning sensitive_gate must request turn pause
    const actController = new AbortController()
    const actRes = await BrowserActTool.call(
      { steps: [{ action: 'click', ref: '@e1', label: 'Pay now' }] },
      { abortController: actController, agentId: 'sub-a' } as never,
    )
    expect(BrowserActTool.mapToolResultToToolResultBlockParam(actRes.data, 't5')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't5',
    })
    expect(consumeUserDecisionTurnPause(actController)).toBe(true)
    clearBrowserUseTakeoverPending('sub-a')

    // BrowserTakeover result formatting
    const tkController = new AbortController()
    const tkRes = await BrowserTakeoverTool.call(
      { reason: 'captcha', message: 'Solve captcha' },
      { abortController: tkController } as never,
    )
    expect(BrowserTakeoverTool.mapToolResultToToolResultBlockParam(tkRes.data, 't6')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't6',
    })

    // Desktop server error responses (JSON message, JSON error, non-JSON, invalid array body)
    globalThis.fetch = (async () =>
      Response.json({ message: 'Tab not found' }, { status: 404 })) as typeof fetch
    await expect(callBrowserUseBridge('snapshot', {})).rejects.toThrow(
      /Browser Use snapshot failed \(404\): Tab not found/,
    )

    globalThis.fetch = (async () =>
      Response.json({ error: 'FORBIDDEN' }, { status: 403 })) as typeof fetch
    await expect(callBrowserUseBridge('snapshot', {})).rejects.toThrow(
      /Browser Use snapshot failed \(403\): FORBIDDEN/,
    )

    globalThis.fetch = (async () =>
      new Response('gateway down', { status: 502 })) as typeof fetch
    await expect(callBrowserUseBridge('snapshot', {})).rejects.toThrow(
      /Browser Use snapshot failed \(502\)/,
    )

    globalThis.fetch = (async () => Response.json(['not', 'object'])) as typeof fetch
    await expect(callBrowserUseBridge('snapshot', {})).rejects.toThrow(
      /Invalid Browser Use snapshot response/,
    )

    // Cleanup swallows network errors cleanly
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    await cleanupBrowserUseAfterTurn({ sessionId: 'sess-all-tools' })
  })
})

function createMockStandaloneChromeManager(options: {
  mode: 'live_attach' | 'managed' | 'awaiting_approval' | 'failed'
}) {
  let connected = options.mode === 'live_attach' || options.mode === 'managed'
  let disconnected = false
  let createdSeq = 1
  const pinned = new Set<string>()
  const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const listeners = new Set<CdpEventListener>()

  const transport: CdpTransport = {
    kind: 'chrome',
    async send<T = Record<string, unknown>>(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      cdpCalls.push({ method, params })
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            {
              targetId: 'user-existing-tab',
              type: 'page',
              title: 'User Tab',
              url: 'https://user.example',
            },
          ],
        } as T
      }
      if (method === 'Target.createTarget') {
        return { targetId: `agent-tab-${createdSeq++}` } as T
      }
      if (method === 'Target.attachToTarget') {
        return { sessionId: `cdp-sess-${String(params?.targetId)}` } as T
      }
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: {
              id: 'frame-1',
              loaderId: 'loader-1',
              url: 'https://example.com',
            },
          },
        } as T
      }
      if (method === 'Page.navigate') {
        return { frameId: 'frame-1', loaderId: 'loader-2' } as T
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: '1',
              role: { value: 'RootWebArea' },
              name: { value: 'Example' },
              childIds: ['2'],
            },
            {
              nodeId: '2',
              backendDOMNodeId: 42,
              role: { value: 'button' },
              name: { value: 'Continue' },
              childIds: [],
            },
          ],
        } as T
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression ?? '')
        if (expr.includes('document.title')) return { result: { value: 'Example' } } as T
        if (expr.includes('location.href')) return { result: { value: 'https://example.com' } } as T
        if (expr.includes('innerText')) return { result: { value: 'Hello Standalone' } } as T
        return { result: { value: [] } } as T
      }
      return {} as T
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    isConnected: () => connected,
    async close() {
      connected = false
    },
  }

  let currentMode: ChromeConnectionState['mode'] = 'disconnected'
  const manager = {
    getState: (): ChromeConnectionState => ({
      mode: currentMode,
      detectedBrowsers: [],
    }),
    getTransport: () => (connected ? transport : null),
    pinTab: (id: string) => {
      pinned.add(id)
    },
    unpinTab: (id: string) => {
      pinned.delete(id)
    },
    connectLiveAttach: async (): Promise<ChromeConnectionState> => {
      if (options.mode === 'awaiting_approval') {
        currentMode = 'awaiting_approval'
        return {
          mode: 'awaiting_approval',
          detectedBrowsers: [],
          guidance: 'Click Allow in Chrome remote debugging dialog.',
        }
      }
      if (options.mode === 'live_attach') {
        currentMode = 'live_attach'
        connected = true
        return { mode: 'live_attach', detectedBrowsers: [] }
      }
      currentMode = 'remote_debugging_not_enabled'
      return { mode: 'remote_debugging_not_enabled', detectedBrowsers: [] }
    },
    launchManagedChrome: async (): Promise<ChromeConnectionState> => {
      if (options.mode === 'managed') {
        currentMode = 'managed'
        connected = true
        return { mode: 'managed', detectedBrowsers: [] }
      }
      currentMode = 'error'
      connected = false
      return {
        mode: 'error',
        detectedBrowsers: [],
        error: 'Chrome binary missing',
      }
    },
    disconnect: async (): Promise<ChromeConnectionState> => {
      disconnected = true
      connected = false
      currentMode = 'disconnected'
      return { mode: 'disconnected', detectedBrowsers: [] }
    },
  } as unknown as ChromeConnectionManager

  return { manager, cdpCalls, pinned, wasDisconnected: () => disconnected }
}

describe('BrowserUseTool standalone CLI fallback & useMergedTools', () => {
  test('fails fast on awaiting_approval without launching managed Chrome', async () => {
    delete process.env.CC_HAHA_DESKTOP_SERVER_URL
    delete process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN
    delete process.env.CC_HAHA_SESSION_ID
    expect(isBrowserUseBridgeDesktopMode()).toBe(false)

    const { manager } = createMockStandaloneChromeManager({
      mode: 'awaiting_approval',
    })
    setStandaloneChromeManagerFactoryForTests(() => manager)

    await expect(
      callBrowserUseBridge('snapshot', {}),
    ).rejects.toThrow(/Click Allow in Chrome/)
  })

  test('handles standalone Chrome unavailable error cleanly', async () => {
    delete process.env.CC_HAHA_DESKTOP_SERVER_URL
    delete process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN
    delete process.env.CC_HAHA_SESSION_ID

    const { manager } = createMockStandaloneChromeManager({ mode: 'failed' })
    setStandaloneChromeManagerFactoryForTests(() => manager)

    await expect(
      callBrowserUseBridge('snapshot', {}),
    ).rejects.toThrow(/Chrome binary missing/)
  })

  test('executes all 6 actions in standalone Live Attach mode with pinned tabs, plus cleanup and shutdown', async () => {
    delete process.env.CC_HAHA_DESKTOP_SERVER_URL
    delete process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN
    delete process.env.CC_HAHA_SESSION_ID
    saveBrowserUseConfig({ enabled: true })

    const mock = createMockStandaloneChromeManager({ mode: 'live_attach' })
    setStandaloneChromeManagerFactoryForTests(() => mock.manager)

    // Navigate without explicit tabId in Live Attach creates a new pinned tab (does NOT hijack user-existing-tab)
    const nav = await callBrowserUseBridge('navigate', {
      url: 'https://example.com',
      waitUntil: 'none',
    })
    expect(nav.tabId).toBe('agent-tab-1')
    expect(mock.pinned.has('agent-tab-1')).toBe(true)

    // Snapshot, act (wait step), inspect, tabs (list/open/focus/close), takeover
    const snap = await callBrowserUseBridge('snapshot', { tabId: 'agent-tab-1' })
    expect(snap.treeText).toContain('Continue')

    const act = await callBrowserUseBridge('act', {
      tabId: 'agent-tab-1',
      steps: [{ action: 'wait', ms: 1 }],
    })
    expect(act.completedSteps).toBe(1)

    const inspected = await callBrowserUseBridge('inspect', {
      tabId: 'agent-tab-1',
      kind: 'text',
    })
    expect(inspected.kind).toBe('text')

    const listRes = await callBrowserUseBridge('tabs', { action: 'list' })
    expect(Array.isArray(listRes.tabs)).toBe(true)

    const openRes = await callBrowserUseBridge('tabs', {
      action: 'open',
      url: 'https://example.com/2',
    })
    const openedTabId = (openRes.tab as { tabId: string }).tabId
    expect(openedTabId).toBe('agent-tab-2')

    // Focus existing user tab (attaches cdpSessionId) and close opened tab
    const focusRes = await callBrowserUseBridge('tabs', {
      action: 'focus',
      tabId: 'user-existing-tab',
    })
    expect((focusRes.tab as { tabId: string }).tabId).toBe('user-existing-tab')

    const closeRes = await callBrowserUseBridge('tabs', {
      action: 'close',
      tabId: openedTabId,
    })
    expect(closeRes.ok).toBe(true)

    // Unknown/invalid tabs and bridge actions throw cleanly
    await expect(callBrowserUseBridge('tabs', { action: 'focus' })).rejects.toThrow(/tabId/)
    await expect(callBrowserUseBridge('tabs', { action: 'close' })).rejects.toThrow(/tabId/)
    await expect(callBrowserUseBridge('tabs', { action: 'bogus' })).rejects.toThrow(/Unsupported/)
    await expect(callBrowserUseBridge('bogus', {})).rejects.toThrow(/Unknown Browser Use action/)

    // Turn-end cleanup releases control on standalone engine
    await cleanupBrowserUseAfterTurn({})

    // Takeover sets pending state
    const tk = await callBrowserUseBridge('takeover', {
      tabId: 'agent-tab-1',
      reason: 'login',
      message: 'Sign in',
    })
    expect(tk.status).toBe('pending')

    // Registered process cleanup disconnects standalone Chrome
    await runCleanupFunctions()
    expect(mock.wasDisconnected()).toBe(true)
  })

  test('falls back to Managed Chrome in standalone mode and reuses existing tab when not Live Attach', async () => {
    delete process.env.CC_HAHA_DESKTOP_SERVER_URL
    delete process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN
    delete process.env.CC_HAHA_SESSION_ID

    const mock = createMockStandaloneChromeManager({ mode: 'managed' })
    setStandaloneChromeManagerFactoryForTests(() => mock.manager)

    const snap = await callBrowserUseBridge('snapshot', {})
    expect(snap.tabId).toBe('user-existing-tab')
  })

  test('useMergedTools strips stale initial Browser* tools when Browser Use is disabled', () => {
    saveBrowserUseConfig({ enabled: false })
    let merged: Tools = []
    function Harness() {
      merged = useMergedTools(
        browserUseTools,
        [],
        getEmptyToolPermissionContext(),
      )
      return null
    }
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream
    const instance1 = render(React.createElement(Harness), { stdout })
    instance1.unmount()
    expect(merged.some(t => isBrowserUseToolName(t.name))).toBe(false)

    saveBrowserUseConfig({ enabled: true })
    const instance2 = render(React.createElement(Harness), { stdout })
    instance2.unmount()
    expect(merged.filter(t => isBrowserUseToolName(t.name)).length).toBe(6)
  })
})
