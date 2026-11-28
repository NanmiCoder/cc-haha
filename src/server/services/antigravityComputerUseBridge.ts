import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
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
import { createAntigravityMcpHttpHost } from './antigravityMcpHttpHost.js'

export const ANTIGRAVITY_COMPUTER_USE_SERVER_NAME = 'cc-haha-computer-use'

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

const ALLOWED_ANTIGRAVITY_CU_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...buildPlatformComputerUseTools({ platform: 'darwin', screenshotFiltering: 'native' }, 'pixels'),
  ...buildPlatformComputerUseTools({ platform: 'linux', screenshotFiltering: 'none' }, 'pixels'),
  ...buildPlatformComputerUseTools({ platform: 'win32', screenshotFiltering: 'none', teachMode: true }, 'pixels'),
].map(tool => tool.name.toLowerCase()))

const CU_MCP_TOOL_PREFIX_RE = /^mcp_{1,2}cc[-_]haha[-_]computer[-_]use_{1,2}([a-z0-9_]+)$/i

/**
 * Match ACP tool names emitted by `agy acp` for our injected Computer Use MCP server.
 * Verified on `agy 1.5.17`: MCP tools arrive as `mcp_<serverName>_<toolName>` (and
 * we also tolerate normalized underscores or double-underscore prefixes), restricted
 * strictly to the exact tool names advertised by `buildPlatformComputerUseTools`.
 */
export function isAntigravityComputerUseToolName(toolName: string | undefined): boolean {
  if (!toolName) return false
  const match = CU_MCP_TOOL_PREFIX_RE.exec(toolName.trim())
  if (!match?.[1]) return false
  return ALLOWED_ANTIGRAVITY_CU_TOOL_NAMES.has(match[1].toLowerCase())
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

const cachedPlatformCuSchemaChars = new Map<'darwin' | 'win32' | 'linux', number>()

/**
 * Read-only token estimate for the injected Computer Use MCP prompt + tool schemas.
 * Used by Antigravity context breakdown to attribute baseline tokens honestly.
 */
export function estimateAntigravityComputerUseTokens(
  bridge?: Pick<AntigravityComputerUseBridge, 'systemPromptAppend'> | null,
  platform: 'darwin' | 'win32' | 'linux' = process.platform === 'win32' || process.platform === 'linux' ? process.platform : 'darwin',
): number {
  let schemaChars = cachedPlatformCuSchemaChars.get(platform)
  if (schemaChars === undefined) {
    const caps = platform === 'darwin'
      ? { platform: 'darwin' as const, screenshotFiltering: 'native' as const }
      : platform === 'win32'
        ? { platform: 'win32' as const, screenshotFiltering: 'none' as const, teachMode: true }
        : { platform: 'linux' as const, screenshotFiltering: 'none' as const }
    schemaChars = JSON.stringify(buildPlatformComputerUseTools(caps, 'pixels')).length
    cachedPlatformCuSchemaChars.set(platform, schemaChars)
  }
  const promptChars = typeof bridge?.systemPromptAppend === 'string' && bridge.systemPromptAppend.length > 0
    ? bridge.systemPromptAppend.length
    : buildAntigravityComputerUsePrompt(platform).length
  return Math.ceil((promptChars + schemaChars) / 3.5)
}

function formatLockHeldMessage(holder: string): string {
  return `Computer use is in use by another session (${holder.slice(0, 8)}…). Wait for that session to finish before continuing.`
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

  let turnAbort = new AbortController()
  const lockTurn = Symbol(`agy-cu-${sessionId}`)
  let selectedDisplayId: number | undefined
  let displayPinnedByModel = false
  let displayResolvedForApps: string | undefined
  let lastScreenshotDims: ScreenshotDims | undefined

  const buildContext = (): ComputerUseSessionContext => ({
    getAgentId: () => `antigravity:${sessionId}`,
    // Single global consent boundary in Settings (per repository rules):
    // never prompt per-app or consume per-app allowlists/denylists.
    getAllowedApps: () => [],
    getGrantFlags: () => ENABLED_GRANT_FLAGS,
    getUserDeniedBundleIds: () => [],
    isAborted: () => host.isClosed() || turnAbort.signal.aborted || !isEnabled(),
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
      if (host.isClosed() || turnAbort.signal.aborted) {
        throw new Error('Computer Use cancelled before lock acquisition')
      }
      if (activeBridgeLock && activeBridgeLock.turn !== lockTurn) {
        throw new Error(formatLockHeldMessage(activeBridgeLock.sessionId))
      }
      const alreadyOwnedBySelf = activeBridgeLock?.turn === lockTurn
      if (!alreadyOwnedBySelf) {
        activeBridgeLock = { sessionId, turn: lockTurn }
      }
      let acquired: AcquireResult
      try {
        acquired = await lockOps.tryAcquire(lockTurn)
      } catch (error) {
        if (!alreadyOwnedBySelf && activeBridgeLock?.turn === lockTurn) {
          activeBridgeLock = null
        }
        throw error
      }
      if (host.isClosed() || turnAbort.signal.aborted) {
        if (!alreadyOwnedBySelf && activeBridgeLock?.turn === lockTurn) {
          activeBridgeLock = null
        }
        if (acquired.kind === 'acquired' && acquired.fresh) {
          await lockOps.release(lockTurn).catch(() => false)
        }
        throw new Error('Computer Use cancelled during lock acquisition')
      }
      if (acquired.kind === 'blocked') {
        if (!alreadyOwnedBySelf && activeBridgeLock?.turn === lockTurn) {
          activeBridgeLock = null
        }
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
      isDisabled: () => host.isClosed() || !isEnabled() || adapter.isDisabled(),
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

  const releaseLock = async (): Promise<void> => {
    if (activeBridgeLock?.turn === lockTurn) {
      activeBridgeLock = null
    }
    await lockOps.release(lockTurn).catch(() => false)
  }

  const host = createAntigravityMcpHttpHost({
    serverName: ANTIGRAVITY_COMPUTER_USE_SERVER_NAME,
    createServer: createBoundServer,
    onBeforeClose: async () => {
      turnAbort.abort()
      await releaseLock()
    },
  })

  const systemPromptAppend = buildAntigravityComputerUsePrompt(platform)

  return {
    serverName: ANTIGRAVITY_COMPUTER_USE_SERVER_NAME,
    url: host.url,
    token: host.token,
    mcpServerConfig: host.mcpServerConfig,
    systemPromptAppend,
    isEnabled: () => !host.isClosed() && isEnabled(),
    abortCurrentTurn: () => {
      turnAbort.abort()
    },
    resetTurnAbort: () => {
      if (!host.isClosed() && turnAbort.signal.aborted) {
        turnAbort = new AbortController()
      }
    },
    releaseLock,
    close: host.close,
  }
}

/** Test helper to clear process-local bridge lock state between isolated test cases. */
export function resetAntigravityComputerUseBridgeLockForTests(): void {
  activeBridgeLock = null
}
