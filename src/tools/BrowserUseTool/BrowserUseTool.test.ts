import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

import { toGeminiParametersSchema } from '../../server/proxy/transform/geminiJsonSchema.js'
import {
  invalidateBrowserUseConfigCache,
  saveBrowserUseConfig,
} from '../../services/browserUse/config.js'
import { getAgentProfile, setAgentProfile } from '../../utils/agentProfile.js'
import { consumeUserDecisionTurnPause } from '../../utils/userDecisionTurnBoundary.js'
import { cleanupBrowserUseAfterTurn, resetBrowserUseBridgeStateForTests } from './bridge.js'
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
})
