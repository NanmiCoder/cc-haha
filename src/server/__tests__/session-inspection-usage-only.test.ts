import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSessionsApi } from '../api/sessions.js'
import { conversationService } from '../services/conversationService.js'
import { __resetWebSocketHandlerStateForTests } from '../ws/handler.js'

/**
 * `usageOnly` exists so the context panel can poll a live session's totals without paying for
 * the full inspection — which additionally scans every skill directory on disk, asks the CLI
 * for MCP status, and re-reads the whole transcript to cross-check usage. Those three are fine
 * once; they are not fine every few seconds. These tests pin both the payload and, more
 * importantly, the set of CLI controls the cheap path is allowed to issue.
 */

const SESSION_ID = 'session-usage-only'

let tempRoot: string
let workDir: string
let requestedSubtypes: string[]
let original: {
  hasSession: typeof conversationService.hasSession
  getSessionWorkDir: typeof conversationService.getSessionWorkDir
  getSessionPermissionMode: typeof conversationService.getSessionPermissionMode
  getSessionInitMessage: typeof conversationService.getSessionInitMessage
  getRecentSdkMessages: typeof conversationService.getRecentSdkMessages
  requestControl: typeof conversationService.requestControl
}

const usageSnapshot = {
  totalCostUSD: 0.5,
  costDisplay: '$0.50',
  hasUnknownModelCost: false,
  totalAPIDuration: 42_000,
  totalDecodeDuration: 12_000,
  totalTtftDuration: 3_000,
  totalDuration: 600,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalInputTokens: 1_000,
  totalOutputTokens: 2_400,
  totalCacheReadInputTokens: 9_000,
  totalCacheCreationInputTokens: 0,
  totalWebSearchRequests: 0,
  models: [],
}

async function inspect(query: string): Promise<Record<string, unknown>> {
  const url = new URL(`http://localhost/api/sessions/${SESSION_ID}/inspection${query}`)
  const response = await handleSessionsApi(
    new Request(url, { method: 'GET' }),
    url,
    ['api', 'sessions', SESSION_ID, 'inspection'],
  )
  expect(response.status).toBe(200)
  return await response.json() as Record<string, unknown>
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-usage-only-'))
  workDir = path.join(tempRoot, 'project')
  await fs.mkdir(workDir, { recursive: true })
  __resetWebSocketHandlerStateForTests()

  requestedSubtypes = []
  original = {
    hasSession: conversationService.hasSession,
    getSessionWorkDir: conversationService.getSessionWorkDir,
    getSessionPermissionMode: conversationService.getSessionPermissionMode,
    getSessionInitMessage: conversationService.getSessionInitMessage,
    getRecentSdkMessages: conversationService.getRecentSdkMessages,
    requestControl: conversationService.requestControl,
  }

  conversationService.hasSession = ((id: string) =>
    id === SESSION_ID) as typeof conversationService.hasSession
  conversationService.getSessionWorkDir = (() =>
    workDir) as typeof conversationService.getSessionWorkDir
  conversationService.getSessionPermissionMode = (() =>
    'default') as typeof conversationService.getSessionPermissionMode
  conversationService.getSessionInitMessage = (() => ({
    type: 'system',
    subtype: 'init',
    model: 'claude-opus-4-7',
    cwd: workDir,
    tools: [],
    mcp_servers: [],
    slash_commands: [],
  })) as typeof conversationService.getSessionInitMessage
  conversationService.getRecentSdkMessages = (() =>
    []) as typeof conversationService.getRecentSdkMessages
  conversationService.requestControl = (async (
    _sessionId: string,
    request: { subtype: string },
  ) => {
    requestedSubtypes.push(request.subtype)
    return request.subtype === 'get_session_usage' ? usageSnapshot : {}
  }) as typeof conversationService.requestControl
})

afterEach(async () => {
  conversationService.hasSession = original.hasSession
  conversationService.getSessionWorkDir = original.getSessionWorkDir
  conversationService.getSessionPermissionMode = original.getSessionPermissionMode
  conversationService.getSessionInitMessage = original.getSessionInitMessage
  conversationService.getRecentSdkMessages = original.getRecentSdkMessages
  conversationService.requestControl = original.requestControl
  __resetWebSocketHandlerStateForTests()
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('session inspection: usageOnly', () => {
  it('returns running totals from a single get_session_usage control', async () => {
    const body = await inspect('?includeContext=0&usageOnly=1')

    expect(requestedSubtypes).toEqual(['get_session_usage'])
    expect(body.usage).toEqual({ ...usageSnapshot, source: 'current_process' })
  })

  it('skips MCP status, unlike the full inspection', async () => {
    await inspect('?includeContext=0&usageOnly=1')

    expect(requestedSubtypes).not.toContain('mcp_status')
    expect(requestedSubtypes).not.toContain('get_context_usage')
  })

  it('does not report context, so a poll cannot be mistaken for a context refresh', async () => {
    const body = await inspect('?includeContext=0&usageOnly=1')

    expect('context' in body).toBe(false)
    expect('contextEstimate' in body).toBe(false)
  })

  it('still asks for the expensive controls on a full inspection', async () => {
    // The negative control for the tests above: if the cheap path were achieved by gutting the
    // full one, every one of these assertions would pass while the inspector lost its data.
    await inspect('?includeContext=1')

    expect(requestedSubtypes).toContain('get_session_usage')
    expect(requestedSubtypes).toContain('get_context_usage')
    expect(requestedSubtypes).toContain('mcp_status')
  })

  it('reports a control failure as an error instead of falling back to a transcript re-read', async () => {
    conversationService.requestControl = (async () => {
      throw new Error('CLI control timed out')
    }) as typeof conversationService.requestControl

    const body = await inspect('?includeContext=0&usageOnly=1')

    // Falling back would mean re-reading the whole JSONL on every tick, which is the cost this
    // mode exists to avoid; the panel keeps its last good numbers and retries instead.
    expect(body.usage).toBeUndefined()
    expect((body.errors as Record<string, string>)?.usage).toContain('CLI control timed out')
  })
})
