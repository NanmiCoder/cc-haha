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
  test('only allows /api/browser-use/config GET/PUT on publicAccess remote gateway and excludes all other routes', () => {
    expect(
      isPublicBusinessPathAllowed(new URL('https://remote.example/api/browser-use/config'), 'GET'),
    ).toBe(true)
    expect(
      isPublicBusinessPathAllowed(new URL('https://remote.example/api/browser-use/config'), 'PUT'),
    ).toBe(true)

    const blockedRoutes: Array<[string, string]> = [
      ['POST', '/api/browser-use/config'],
      ['DELETE', '/api/browser-use/config'],
      ['GET', '/api/browser-use/status'],
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

    for (const [method, pathname] of blockedRoutes) {
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

  test('scopes remoteBrowser (LAN H5 / paired phone) to safe /api/browser-use/config projection and blocks desktop-only fields & routes', async () => {
    const blockedRoutes: Array<[string, string]> = [
      ['GET', '/api/browser-use/status'],
      ['POST', '/api/browser-use/chrome/connect'],
      ['POST', '/api/browser-use/chrome/launch-managed'],
      ['POST', '/api/browser-use/chrome/disconnect'],
      ['POST', '/api/browser-use/takeover/resume'],
      ['POST', '/api/browser-use/takeover/abort'],
    ]

    for (const [method, pathname] of blockedRoutes) {
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

    const tempConfigDir = mkdtempSync(join(tmpdir(), 'cc-haha-remote-browser-use-'))
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
    try {
      const configUrl = new URL('http://127.0.0.1:3456/api/browser-use/config')

      // Desktop-only fields are rejected with 403 from remote callers
      for (const badBody of [
        { chromeBinaryPath: '/Applications/Google Chrome.app' },
        { chromeUserDataDir: '/tmp/profile' },
        { blockedLoopbackPorts: [8080] },
        { managedChromeHeadless: true },
        { showCursorOverlay: false },
      ]) {
        const res = await handleApiRequest(
          new Request(configUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(badBody),
          }),
          configUrl,
          { remoteBrowser: true },
        )
        expect(res.status).toBe(403)
      }

      // Invalid target value on allowed field returns 400
      const invalidTarget = await handleApiRequest(
        new Request(configUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferredTarget: 'safari' }),
        }),
        configUrl,
        { remoteBrowser: true },
      )
      expect(invalidTarget.status).toBe(400)

      // Allowed remote mutation succeeds and projects out desktop-only fields
      const putRes = await handleApiRequest(
        new Request(configUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: true,
            preferredTarget: 'workspace',
            consentAcceptedAt: '2026-11-28T00:00:00.000Z',
          }),
        }),
        configUrl,
        { remoteBrowser: true },
      )
      expect(putRes.status).toBe(200)
      const putJson = (await putRes.json()) as Record<string, unknown>
      expect(putJson.enabled).toBe(true)
      expect(putJson.preferredTarget).toBe('workspace')
      expect(putJson.consentAcceptedAt).toBe('2026-11-28T00:00:00.000Z')
      expect('chromeBinaryPath' in putJson).toBe(false)
      expect('chromeUserDataDir' in putJson).toBe(false)
      expect('blockedLoopbackPorts' in putJson).toBe(false)
      expect('showCursorOverlay' in putJson).toBe(false)

      const getRes = await handleApiRequest(
        new Request(configUrl, { method: 'GET' }),
        configUrl,
        { remoteBrowser: true },
      )
      expect(getRes.status).toBe(200)
      const getJson = (await getRes.json()) as Record<string, unknown>
      expect(getJson.enabled).toBe(true)
      expect(getJson.preferredTarget).toBe('workspace')
      expect('chromeBinaryPath' in getJson).toBe(false)
      expect('managedChromeHeadless' in getJson).toBe(false)
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      rmSync(tempConfigDir, { recursive: true, force: true })
    }
  })

  test('covers all internal CLI tool actions, schema rejections, 405, invalid agentId, and invalid JSON', async () => {
    const { service, calls } = createMockService()
    const post = (action: string, body: string) =>
      handleBrowserUseToolApi(
        new Request(`http://127.0.0.1/api/browser-use/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
        action as never,
        'sess-all',
        service,
      )

    // 405 Method Not Allowed
    const getRes = await handleBrowserUseToolApi(
      new Request('http://127.0.0.1/api/browser-use/tabs', { method: 'GET' }),
      'tabs',
      'sess-all',
      service,
    )
    expect(getRes.status).toBe(405)

    // Empty / invalid JSON / non-object JSON / bad agentId
    expect((await post('tabs', '')).status).toBe(400)
    expect((await post('tabs', '{bad')).status).toBe(400)
    expect((await post('tabs', '[]')).status).toBe(400)
    expect((await post('tabs', JSON.stringify({ action: 'list', agentId: '' }))).status).toBe(400)

    // Invalid schema per action
    expect((await post('tabs', JSON.stringify({ action: 'bogus' }))).status).toBe(400)
    expect((await post('navigate', JSON.stringify({ action: 'bogus' }))).status).toBe(400)
    expect((await post('snapshot', JSON.stringify({ maxNodes: 1 }))).status).toBe(400)
    expect((await post('inspect', JSON.stringify({ kind: 'bogus' }))).status).toBe(400)
    expect((await post('takeover', JSON.stringify({ reason: 'login', message: '' }))).status).toBe(400)

    // Valid calls for every internal action
    expect((await post('tabs', JSON.stringify({ action: 'list' }))).status).toBe(200)
    expect((await post('navigate', JSON.stringify({ url: 'https://example.com' }))).status).toBe(200)
    expect((await post('snapshot', JSON.stringify({ diff: true }))).status).toBe(200)
    expect((await post('inspect', JSON.stringify({ kind: 'console', limit: 10 }))).status).toBe(200)
    expect(
      (await post('takeover', JSON.stringify({ reason: 'login', message: 'Sign in' }))).status,
    ).toBe(200)
    expect((await post('cleanup', '')).status).toBe(200)

    expect(calls.map(c => c.method)).toEqual([
      'executeTabs',
      'executeNavigate',
      'executeSnapshot',
      'executeInspect',
      'executeTakeover',
      'cleanupAfterTurn',
    ])
  })

  test('covers remaining UI REST validation, config patch fields, errors, and 404 routes', async () => {
    const { service } = createMockService({
      connectChrome: (async () => ({
        chrome: { mode: 'error', error: 'Attach failed', detectedBrowsers: [] },
        status: {} as BrowserUseStatus,
      })) as never,
      launchManagedChrome: (async () => ({
        chrome: { mode: 'error', error: 'Spawn failed', detectedBrowsers: [] },
        status: {} as BrowserUseStatus,
      })) as never,
    })

    // GET /config
    const getCfg = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/config', { method: 'GET' }),
      new URL('http://127.0.0.1/api/browser-use/config'),
      ['api', 'browser-use', 'config'],
      service,
    )
    expect(getCfg.status).toBe(200)

    // connect & launch-managed error propagation
    const connErr = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/chrome/connect', {
        method: 'POST',
        body: '',
      }),
      new URL('http://127.0.0.1/api/browser-use/chrome/connect'),
      ['api', 'browser-use', 'chrome', 'connect'],
      service,
    )
    expect(await connErr.json()).toMatchObject({ ok: false, error: 'Attach failed' })

    const launchErr = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/chrome/launch-managed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browserId: 'edge', headless: true }),
      }),
      new URL('http://127.0.0.1/api/browser-use/chrome/launch-managed'),
      ['api', 'browser-use', 'chrome', 'launch-managed'],
      service,
    )
    expect(await launchErr.json()).toMatchObject({ ok: false, error: 'Spawn failed' })

    // takeover resume/abort missing sessionId -> 400
    const badResume = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/takeover/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: '' }),
      }),
      new URL('http://127.0.0.1/api/browser-use/takeover/resume'),
      ['api', 'browser-use', 'takeover', 'resume'],
      service,
    )
    expect(badResume.status).toBe(400)

    const badAbort = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/takeover/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: '' }),
      }),
      new URL('http://127.0.0.1/api/browser-use/takeover/abort'),
      ['api', 'browser-use', 'takeover', 'abort'],
      service,
    )
    expect(badAbort.status).toBe(400)

    // Unknown UI route -> 404
    const notFound = await handleBrowserUseUiApi(
      new Request('http://127.0.0.1/api/browser-use/unknown', { method: 'GET' }),
      new URL('http://127.0.0.1/api/browser-use/unknown'),
      ['api', 'browser-use', 'unknown'],
      service,
    )
    expect(notFound.status).toBe(404)

    // parseBrowserUseConfigPatch edge validation
    expect(parseBrowserUseConfigPatch(null)).toBeNull()
    expect(parseBrowserUseConfigPatch({ preferredTarget: 'invalid' })).toBeNull()
    expect(parseBrowserUseConfigPatch({ showCursorOverlay: 'yes' })).toBeNull()
    expect(parseBrowserUseConfigPatch({ autoOpenWorkspacePanel: 1 })).toBeNull()
    expect(parseBrowserUseConfigPatch({ managedChromeHeadless: 1 })).toBeNull()
    expect(parseBrowserUseConfigPatch({ chromeBinaryPath: 123 })).toBeNull()
    expect(parseBrowserUseConfigPatch({ chromeUserDataDir: 123 })).toBeNull()
    expect(parseBrowserUseConfigPatch({ consentAcceptedAt: 123 })).toBeNull()
    expect(
      parseBrowserUseConfigPatch({
        autoOpenWorkspacePanel: false,
        managedChromeHeadless: true,
        chromeUserDataDir: '  /tmp/profile  ',
        consentAcceptedAt: '2026-01-01T00:00:00Z',
      }),
    ).toEqual({
      autoOpenWorkspacePanel: false,
      managedChromeHeadless: true,
      chromeUserDataDir: '/tmp/profile',
      consentAcceptedAt: '2026-01-01T00:00:00Z',
    })
  })
})
