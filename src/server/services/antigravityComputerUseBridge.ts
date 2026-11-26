import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  buildPlatformComputerUseTools,
  createComputerUseMcpServer,
  type ComputerUseHostAdapter,
  type ComputerUseSessionContext,
  type CoordinateMode,
  type ScreenshotDims,
} from '../../vendor/computer-use-mcp/index.js'
import { getComputerUsePrompt } from '../../skills/bundled/computerUse.js'
import {
  checkComputerUseLock,
  releaseComputerUseLock,
  tryAcquireComputerUseLock,
  type AcquireResult,
  type CheckResult,
} from '../../utils/computerUse/computerUseLock.js'
import { getChicagoCoordinateMode } from '../../utils/computerUse/gates.js'
import { getComputerUseHostAdapter } from '../../utils/computerUse/hostAdapter.js'
import { isComputerUseEnabledForDispatch } from '../../utils/computerUse/skillGate.js'
import type { AntigravityMcpServerConfig } from './antigravityAcp.js'

export const ANTIGRAVITY_COMPUTER_USE_SERVER_NAME = 'cc-haha-computer-use'
const MCP_PATH = '/mcp'

const ENABLED_GRANT_FLAGS = {
  clipboardRead: true,
  clipboardWrite: true,
  systemKeyCombos: true,
} as const

type ActiveBridgeLock = {
  sessionId: string
  turn: symbol
}

let activeBridgeLock: ActiveBridgeLock | null = null

export type ComputerUseLockOps = {
  check: () => Promise<CheckResult>
  tryAcquire: (turn?: symbol) => Promise<AcquireResult>
  release: (turn?: symbol) => Promise<boolean>
}

export type AntigravityComputerUseBridgeDeps = {
  isEnabled?: () => boolean
  adapter?: ComputerUseHostAdapter
  coordinateMode?: CoordinateMode
  platform?: 'darwin' | 'win32' | 'linux'
  lockOps?: ComputerUseLockOps
  installedAppNames?: string[]
}

export type AntigravityComputerUseBridge = {
  readonly serverName: typeof ANTIGRAVITY_COMPUTER_USE_SERVER_NAME
  readonly url: string
  readonly token: string
  readonly mcpServerConfig: AntigravityMcpServerConfig
  readonly systemPromptAppend: string
  isEnabled(): boolean
  abortCurrentTurn(): void
  resetTurnAbort(): void
  releaseLock(): Promise<void>
  close(): Promise<void>
}

function normalizeServerPrefix(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

const NORMALIZED_CU_SERVER_PREFIX = normalizeServerPrefix(ANTIGRAVITY_COMPUTER_USE_SERVER_NAME)

/**
 * Match ACP tool names emitted by `agy acp` for our injected Computer Use MCP server.
 * Verified on `agy 1.5.17`: MCP tools arrive as `mcp_<serverName>_<toolName>` (and
 * we also tolerate normalized underscores or double-underscore prefixes).
 */
export function isAntigravityComputerUseToolName(toolName: string | undefined): boolean {
  if (!toolName) return false
  const normalized = normalizeServerPrefix(toolName)
  return normalized.startsWith(`mcp_${NORMALIZED_CU_SERVER_PREFIX}_`)
}

export function buildAntigravityComputerUsePrompt(
  platform: 'darwin' | 'win32' | 'linux' = process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'darwin',
): string {
  const basePrompt = getComputerUsePrompt(platform)
  const header = [
    `# cc-haha Computer Use MCP (${ANTIGRAVITY_COMPUTER_USE_SERVER_NAME})`,
    `When the user asks to inspect or operate native desktop applications on this machine, use the MCP tools provided by \`${ANTIGRAVITY_COMPUTER_USE_SERVER_NAME}\` (such as \`js\` / \`js_reset\` on macOS or \`desktop\` on Windows/Linux).`,
    'Computer Use is already globally authorized in cc-haha Settings for this session. Do not bypass it with osascript, AppleScript, System Events, or shell GUI scripting.',
  ].join('\n')
  return `${header}\n\n${basePrompt}`
}

function tokensEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function formatLockHeldMessage(holder: string): string {
  return `Computer use is in use by another session (${holder.slice(0, 8)}…). Wait for that session to finish before continuing.`
}

type McpSessionEntry = {
  server: Server
  transport: WebStandardStreamableHTTPServerTransport
}

/**
 * Create a per-session loopback Streamable HTTP MCP bridge exposing cc-haha's real
 * Computer Use execution engine (`createComputerUseMcpServer` + `bindSessionContext`)
 * to `agy acp`. Returns `null` when Computer Use is disabled in Settings.
 */
export async function createAntigravityComputerUseBridge(
  sessionId: string,
  deps: AntigravityComputerUseBridgeDeps = {},
): Promise<AntigravityComputerUseBridge | null> {
  const isEnabled = deps.isEnabled ?? (() => isComputerUseEnabledForDispatch())
  if (!isEnabled()) return null

  const platform: 'darwin' | 'win32' | 'linux' =
    deps.platform ?? (process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'darwin')
  const adapter = deps.adapter ?? getComputerUseHostAdapter()
  const coordinateMode = deps.coordinateMode ?? getChicagoCoordinateMode()
  const lockOps: ComputerUseLockOps = deps.lockOps ?? {
    check: checkComputerUseLock,
    tryAcquire: tryAcquireComputerUseLock,
    release: releaseComputerUseLock,
  }

  let closed = false
  let turnAbort = new AbortController()
  const lockTurn = Symbol(`agy-cu-${sessionId}`)
  let selectedDisplayId: number | undefined
  let displayPinnedByModel = false
  let displayResolvedForApps: string | undefined
  let lastScreenshotDims: ScreenshotDims | undefined
  const sessions = new Map<string, McpSessionEntry>()

  const buildContext = (): ComputerUseSessionContext => ({
    getAgentId: () => `antigravity:${sessionId}`,
    // Single global consent boundary in Settings (per repository rules):
    // never prompt per-app or consume per-app allowlists/denylists.
    getAllowedApps: () => [],
    getGrantFlags: () => ENABLED_GRANT_FLAGS,
    getUserDeniedBundleIds: () => [],
    isAborted: () => closed || turnAbort.signal.aborted || !isEnabled(),
    getSelectedDisplayId: () => selectedDisplayId,
    getDisplayPinnedByModel: () => displayPinnedByModel,
    getDisplayResolvedForApps: () => displayResolvedForApps,
    getLastScreenshotDims: () => lastScreenshotDims,
    onAppsHidden: () => {},
    onResolvedDisplayUpdated: (id) => {
      selectedDisplayId = id
      displayPinnedByModel = false
      displayResolvedForApps = undefined
    },
    onDisplayPinned: (id) => {
      selectedDisplayId = id
      displayPinnedByModel = id !== undefined
      if (!displayPinnedByModel) displayResolvedForApps = undefined
    },
    onDisplayResolvedForApps: (key) => {
      displayResolvedForApps = key
    },
    onScreenshotCaptured: (dims) => {
      lastScreenshotDims = dims
    },
    checkCuLock: async () => {
      if (activeBridgeLock && activeBridgeLock.turn !== lockTurn) {
        return { holder: activeBridgeLock.sessionId, isSelf: false }
      }
      const result = await lockOps.check()
      switch (result.kind) {
        case 'free':
          return { holder: undefined, isSelf: false }
        case 'held_by_self':
          return activeBridgeLock && activeBridgeLock.turn === lockTurn
            ? { holder: sessionId, isSelf: true }
            : { holder: undefined, isSelf: false }
        case 'blocked':
          return { holder: result.by, isSelf: false }
      }
    },
    acquireCuLock: async () => {
      if (closed || turnAbort.signal.aborted) {
        throw new Error('Computer Use cancelled before lock acquisition')
      }
      if (activeBridgeLock && activeBridgeLock.turn !== lockTurn) {
        throw new Error(formatLockHeldMessage(activeBridgeLock.sessionId))
      }
      const acquired = await lockOps.tryAcquire(lockTurn)
      if (closed || turnAbort.signal.aborted) {
        if (acquired.kind === 'acquired' && acquired.fresh) {
          await lockOps.release(lockTurn)
        }
        throw new Error('Computer Use cancelled during lock acquisition')
      }
      if (acquired.kind === 'blocked') {
        throw new Error(formatLockHeldMessage(acquired.by))
      }
      activeBridgeLock = { sessionId, turn: lockTurn }
    },
    formatLockHeldMessage,
  })

  const createBoundServer = (): Server => {
    const gatedAdapter: ComputerUseHostAdapter = {
      ...adapter,
      serverName: ANTIGRAVITY_COMPUTER_USE_SERVER_NAME,
      isDisabled: () => closed || !isEnabled() || adapter.isDisabled(),
    }
    const server = createComputerUseMcpServer(gatedAdapter, coordinateMode, buildContext())
    if (deps.installedAppNames) {
      const tools = buildPlatformComputerUseTools(
        gatedAdapter.executor.capabilities,
        coordinateMode,
        deps.installedAppNames,
      )
      server.setRequestHandler(ListToolsRequestSchema, async () =>
        gatedAdapter.isDisabled() ? { tools: [] } : { tools },
      )
    }
    return server
  }

  const token = randomBytes(24).toString('hex')
  const expectedAuth = `Bearer ${token}`

  const httpServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      // agy probes OAuth protected-resource metadata unauthenticated on HTTP MCP.
      if (req.method === 'GET' && url.pathname.startsWith('/.well-known/')) {
        return new Response('Not Found', { status: 404 })
      }
      if (url.pathname !== MCP_PATH) {
        return new Response('Not Found', { status: 404 })
      }
      const authHeader = req.headers.get('authorization') ?? ''
      if (!tokensEqual(expectedAuth, authHeader)) {
        return new Response('Unauthorized', { status: 401 })
      }
      if (closed) {
        return new Response('Bridge closed', { status: 503 })
      }

      let parsedBody: unknown
      if (req.method === 'POST') {
        const rawText = await req.text()
        if (rawText.trim()) {
          try {
            parsedBody = JSON.parse(rawText)
          } catch {
            return Response.json(
              { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
              { status: 400 },
            )
          }
        }
        // agy 1.5.17 sends `server/discover` before `initialize`; reply -32601 cleanly so it falls back to standard initialize.
        if (
          parsedBody &&
          typeof parsedBody === 'object' &&
          !Array.isArray(parsedBody) &&
          (parsedBody as Record<string, unknown>).method === 'server/discover'
        ) {
          const rpcId = (parsedBody as Record<string, unknown>).id ?? null
          return Response.json({
            jsonrpc: '2.0',
            id: rpcId,
            error: { code: -32601, message: 'Method not found' },
          })
        }
      }

      const mcpSessionId = req.headers.get('mcp-session-id') ?? undefined
      let entry = mcpSessionId ? sessions.get(mcpSessionId) : undefined
      if (!entry) {
        const server = createBoundServer()
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { server, transport })
          },
          onsessionclosed: (id) => {
            sessions.delete(id)
          },
        })
        await server.connect(transport)
        entry = { server, transport }
      }

      return entry.transport.handleRequest(req, parsedBody !== undefined ? { parsedBody } : undefined)
    },
  })

  const url = `http://127.0.0.1:${httpServer.port}${MCP_PATH}`
  const mcpServerConfig: AntigravityMcpServerConfig = {
    type: 'http',
    name: ANTIGRAVITY_COMPUTER_USE_SERVER_NAME,
    url,
    headers: [{ name: 'Authorization', value: expectedAuth }],
  }
  const systemPromptAppend = buildAntigravityComputerUsePrompt(platform)

  const releaseLock = async (): Promise<void> => {
    if (activeBridgeLock?.turn === lockTurn) {
      activeBridgeLock = null
    }
    await lockOps.release(lockTurn).catch(() => false)
  }

  return {
    serverName: ANTIGRAVITY_COMPUTER_USE_SERVER_NAME,
    url,
    token,
    mcpServerConfig,
    systemPromptAppend,
    isEnabled: () => !closed && isEnabled(),
    abortCurrentTurn: () => {
      turnAbort.abort()
    },
    resetTurnAbort: () => {
      if (!closed && turnAbort.signal.aborted) {
        turnAbort = new AbortController()
      }
    },
    releaseLock,
    close: async () => {
      if (closed) return
      closed = true
      turnAbort.abort()
      await releaseLock()
      const entries = [...sessions.values()]
      sessions.clear()
      await Promise.allSettled(entries.map(async ({ server, transport }) => {
        await transport.close().catch(() => {})
        await server.close().catch(() => {})
      }))
      httpServer.stop(true)
    },
  }
}

/** Test helper to clear process-local bridge lock state between isolated test cases. */
export function resetAntigravityComputerUseBridgeLockForTests(): void {
  activeBridgeLock = null
}
