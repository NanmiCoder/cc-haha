import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleApiRequest } from '../router.js'
import { isPublicBusinessPathAllowed } from '../publicAccess.js'
import { authenticateCollaborationCaller } from '../sessionCollaborationAuth.js'
import {
  browserUseToolAction,
  handleBrowserUseToolApi,
  handleBrowserUseUiApi,
  parseBrowserUseConfigPatch,
} from '../api/browser-use.js'
import type { BrowserUseService } from '../services/browserUseService.js'
import type {
  BrowserUseConfig,
  BrowserUseStatus,
} from '../../services/browserUse/types.js'

function createMockService(overrides: Partial<BrowserUseService> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  let config: BrowserUseConfig = {
    enabled: false,
    preferredTarget: 'auto',
    showCursorOverlay: true,
    autoOpenWorkspacePanel: true,
    managedChromeHeadless: false,
  }
  const makeStatus = (): BrowserUseStatus => ({
    enabled: config.enabled,
    preferredTarget: config.preferredTarget,
    activeTarget: 'workspace',
    workspaceAvailable: true,
    chrome: {
      mode: 'disconnected',
      detectedBrowsers: [],
    },
    controlState: 'idle',
    tabs: [],
    config,
  })

  const service = {
    getStatus: async () => {
      calls.push({ method: 'getStatus', args: [] })
      return makeStatus()
    },
    getConfig: () => {
      calls.push({ method: 'getConfig', args: [] })
      return { ...config }
    },
    updateConfig: (patch: Partial<BrowserUseConfig>) => {
      calls.push({ method: 'updateConfig', args: [patch] })
      config = { ...config, ...patch }
      return { ...config }
    },
    connectChrome: async (opts: unknown) => {
      calls.push({ method: 'connectChrome', args: [opts] })
      const chrome = {
        mode: 'live_attach' as const,
        browserName: 'Google Chrome',
        detectedBrowsers: [],
      }
      return { chrome, status: { ...makeStatus(), chrome } }
    },
    launchManagedChrome: async (opts: unknown) => {
      calls.push({ method: 'launchManagedChrome', args: [opts] })
      const chrome = {
        mode: 'managed' as const,
        browserName: 'Google Chrome',
        port: 49152,
        detectedBrowsers: [],
      }
      return { chrome, status: { ...makeStatus(), chrome } }
    },
    disconnectChrome: async () => {
      calls.push({ method: 'disconnectChrome', args: [] })
      return makeStatus()
    },
    resumeTakeover: async (opts: unknown) => {
      calls.push({ method: 'resumeTakeover', args: [opts] })
      return { resumed: true }
    },
    abortTakeover: async (opts: unknown) => {
      calls.push({ method: 'abortTakeover', args: [opts] })
      return {}
    },
    executeTabs: async (opts: unknown) => {
      calls.push({ method: 'executeTabs', args: [opts] })
      return { tabs: [] }
    },
    executeNavigate: async (opts: unknown) => {
      calls.push({ method: 'executeNavigate', args: [opts] })
      return { tabId: 'tab-1', target: 'workspace', url: 'https://example.com', title: 'Example' }
    },
    executeSnapshot: async (opts: unknown) => {
      calls.push({ method: 'executeSnapshot', args: [opts] })
      return { tabId: 'tab-1', target: 'workspace', url: 'https://example.com', title: 'Example', treeText: '' }
    },
    executeAct: async (opts: unknown) => {
      calls.push({ method: 'executeAct', args: [opts] })
      return { tabId: 'tab-1', target: 'workspace', completedSteps: 1, totalSteps: 1, results: [] }
    },
    executeInspect: async (opts: unknown) => {
      calls.push({ method: 'executeInspect', args: [opts] })
      return { tabId: 'tab-1', target: 'workspace', kind: 'console', url: 'https://example.com' }
    },
    executeTakeover: async (opts: unknown) => {
      calls.push({ method: 'executeTakeover', args: [opts] })
      return { takeoverId: 'tk-1', tabId: 'tab-1', target: 'workspace', reason: 'login', message: 'Sign in', status: 'pending', createdAt: Date.now() }
    },
    cleanupAfterTurn: async (opts: unknown) => {
      calls.push({ method: 'cleanupAfterTurn', args: [opts] })
      return { ok: true, preservedTakeover: false }
    },
    ...overrides,
  } as unknown as BrowserUseService

  return { service, calls }
}

describe('Browser Use API routing and security boundaries', () => {
  test('strictly excludes all /api/browser-use/* routes from publicAccess remote gateway', () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/browser-use/status'],
      ['GET', '/api/browser-use/config'],
      ['PUT', '/api/browser-use/config'],
      ['POST', '/api/browser-use/chrome/connect'],
      ['POST', '/api/browser-use/chrome/launch-managed'],
      ['POST', '/api/browser-use/chrome/disconnect'],
      ['POST', '/api/browser-use/takeover/resume'],
      ['POST', '/api/browser-use/takeover/abort'],
      ['POST', '/api/browser-use/tabs'],
      ['POST', '/api/browser-use/navigate'],
      ['POST', '/api/browser-use/snapshot'],
      ['POST', '/api/browser-use/act'],
      ['POST', '/api/browser-use/inspect'],
      ['POST', '/api/browser-use/takeover'],
      ['POST', '/api/browser-use/cleanup'],
    ]

    for (const [method, pathname] of routes) {
      expect(
        isPublicBusinessPathAllowed(new URL(`https://remote.example${pathname}`), method),
      ).toBe(false)
    }
  })

  test('matches only internal CLI tool actions and requires valid SDK credentials without Origin', () => {
    expect(browserUseToolAction('/api/browser-use/tabs')).toBe('tabs')
    expect(browserUseToolAction('/api/browser-use/navigate')).toBe('navigate')
    expect(browserUseToolAction('/api/browser-use/snapshot')).toBe('snapshot')
    expect(browserUseToolAction('/api/browser-use/act')).toBe('act')
    expect(browserUseToolAction('/api/browser-use/inspect')).toBe('inspect')
    expect(browserUseToolAction('/api/browser-use/takeover')).toBe('takeover')
    expect(browserUseToolAction('/api/browser-use/cleanup')).toBe('cleanup')

    // UI endpoints must NOT be intercepted as internal tool actions
    expect(browserUseToolAction('/api/browser-use/status')).toBeNull()
    expect(browserUseToolAction('/api/browser-use/config')).toBeNull()
    expect(browserUseToolAction('/api/browser-use/chrome/connect')).toBeNull()
    expect(browserUseToolAction('/api/browser-use/takeover/resume')).toBeNull()

    const authorize = (id: string, token: string) => id === 'sess-1' && token === 'valid-sdk'
    const validReq = new Request('http://127.0.0.1/api/browser-use/snapshot', {
      method: 'POST',
      headers: {
        'X-Session-Id': 'sess-1',
        Authorization: 'Bearer valid-sdk',
      },
    })
    expect(authenticateCollaborationCaller(validReq, authorize)).toBe('sess-1')

    const originReq = new Request('http://127.0.0.1/api/browser-use/snapshot', {
      method: 'POST',
      headers: {
        Origin: 'http://evil.example',
        'X-Session-Id': 'sess-1',
        Authorization: 'Bearer valid-sdk',
      },
    })
    expect(authenticateCollaborationCaller(originReq, authorize)).toBeNull()
  })

  test('validates internal tool payloads and forwards callerSessionId + agentId', async () => {
    const { service, calls } = createMockService()

    const badAct = await handleBrowserUseToolApi(
      new Request('http://127.0.0.1/api/browser-use/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: [] }),
      }),
      'act',
      'sess-1',
      service,
    )
    expect(badAct.status).toBe(400)

    const goodAct = await handleBrowserUseToolApi(
      new Request('http://127.0.0.1/api/browser-use/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'sub-1',
          steps: [{ action: 'click', ref: '@e2', label: 'Sign in' }],
        }),
      }),
      'act',
      'sess-1',
      service,
    )
    expect(goodAct.status).toBe(200)
    expect(calls[0]?.method).toBe('executeAct')
    expect(calls[0]?.args[0]).toMatchObject({
      sessionId: 'sess-1',
      agentId: 'sub-1',
      steps: [{ action: 'click', ref: '@e2', label: 'Sign in' }],
    })
  })

  test('handles all UI REST endpoints (status, config, chrome lifecycle, takeover resume/abort)', async () => {
    const { service, calls } = createMockService()

    const statusRes = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/status', { method: 'GET' }),
      new URL('http://127.0.0.1/api/browser-use/status'),
      ['api', 'browser-use', 'status'],
      service,
    )
    expect(statusRes.status).toBe(200)
    expect((await statusRes.json()).workspaceAvailable).toBe(true)

    const badConfig = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      }),
      new URL('http://127.0.0.1/api/browser-use/config'),
      ['api', 'browser-use', 'config'],
      service,
    )
    expect(badConfig.status).toBe(400)

    const goodConfig = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          preferredTarget: 'chrome',
          showCursorOverlay: false,
        }),
      }),
      new URL('http://127.0.0.1/api/browser-use/config'),
      ['api', 'browser-use', 'config'],
      service,
    )
    expect(goodConfig.status).toBe(200)
    expect(await goodConfig.json()).toMatchObject({
      enabled: true,
      preferredTarget: 'chrome',
      showCursorOverlay: false,
    })

    const connectRes = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/chrome/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browserId: 'chrome', timeoutMs: 25_000 }),
      }),
      new URL('http://127.0.0.1/api/browser-use/chrome/connect'),
      ['api', 'browser-use', 'chrome', 'connect'],
      service,
    )
    expect(connectRes.status).toBe(200)
    expect((await connectRes.json()).ok).toBe(true)

    const managedRes = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/chrome/launch-managed', {
        method: 'POST',
      }),
      new URL('http://127.0.0.1/api/browser-use/chrome/launch-managed'),
      ['api', 'browser-use', 'chrome', 'launch-managed'],
      service,
    )
    expect(managedRes.status).toBe(200)
    expect((await managedRes.json()).ok).toBe(true)

    const disconnectRes = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/chrome/disconnect', {
        method: 'POST',
      }),
      new URL('http://127.0.0.1/api/browser-use/chrome/disconnect'),
      ['api', 'browser-use', 'chrome', 'disconnect'],
      service,
    )
    expect(disconnectRes.status).toBe(200)
    expect((await disconnectRes.json()).ok).toBe(true)

    const resumeRes = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/takeover/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1', takeoverId: 'tk-1' }),
      }),
      new URL('http://127.0.0.1/api/browser-use/takeover/resume'),
      ['api', 'browser-use', 'takeover', 'resume'],
      service,
    )
    expect(resumeRes.status).toBe(200)
    expect(await resumeRes.json()).toMatchObject({ ok: true, resumed: true })

    const abortRes = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/takeover/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1', reason: 'user cancelled' }),
      }),
      new URL('http://127.0.0.1/api/browser-use/takeover/abort'),
      ['api', 'browser-use', 'takeover', 'abort'],
      service,
    )
    expect(abortRes.status).toBe(200)
    expect(await abortRes.json()).toMatchObject({ ok: true })
    expect(calls.map(c => c.method)).toContain('abortTakeover')
  })

  test('rejects unknown config patch keys, invalid loopback ports, and invalid chromeBinaryPath', () => {
    expect(parseBrowserUseConfigPatch({ unknownKey: true })).toBeNull()
    expect(parseBrowserUseConfigPatch({ blockedLoopbackPorts: [0] })).toBeNull()
    expect(parseBrowserUseConfigPatch({ blockedLoopbackPorts: [3456] })).toEqual({
      blockedLoopbackPorts: [3456],
    })
    // Reject non-existent path and shell metacharacters
    expect(
      parseBrowserUseConfigPatch({ chromeBinaryPath: '/nonexistent/path/to/chrome' }),
    ).toBeNull()
    expect(
      parseBrowserUseConfigPatch({ chromeBinaryPath: '/bin/sh; rm -rf /' }),
    ).toBeNull()
    // Allow clearing custom path
    expect(parseBrowserUseConfigPatch({ chromeBinaryPath: '' })).toEqual({
      chromeBinaryPath: '',
    })
    // Allow an existing regular file
    const dir = mkdtempSync(join(tmpdir(), 'cc-haha-chrome-bin-'))
    try {
      const bin = join(dir, 'chrome-mock')
      writeFileSync(bin, '#!/bin/sh\n')
      expect(parseBrowserUseConfigPatch({ chromeBinaryPath: bin })).toEqual({
        chromeBinaryPath: bin,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('blocks remoteBrowser (LAN H5) requests to all /api/browser-use/* routes with 403', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/browser-use/status'],
      ['GET', '/api/browser-use/config'],
      ['PUT', '/api/browser-use/config'],
      ['POST', '/api/browser-use/chrome/connect'],
      ['POST', '/api/browser-use/chrome/launch-managed'],
      ['POST', '/api/browser-use/chrome/disconnect'],
      ['POST', '/api/browser-use/takeover/resume'],
      ['POST', '/api/browser-use/takeover/abort'],
    ]

    for (const [method, pathname] of routes) {
      const url = new URL(`http://127.0.0.1:3456${pathname}`)
      const req = new Request(url, {
        method,
        ...(method === 'PUT' || method === 'POST'
          ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
          : {}),
      })
      const res = await handleApiRequest(req, url, { remoteBrowser: true })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Desktop-only capability' })
    }
  })
})
