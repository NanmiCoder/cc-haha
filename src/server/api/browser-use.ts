import { statSync } from 'node:fs'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  browserActSchema,
  browserInspectSchema,
  browserNavigateSchema,
  browserSnapshotSchema,
  browserTabsSchema,
  browserTakeoverSchema,
} from '../../tools/BrowserUseTool/schemas.js'
import type {
  BrowserPreferredTarget,
  BrowserUseConfig,
  DetectedBrowserId,
} from '../../services/browserUse/types.js'
import {
  getBrowserUseService,
  type BrowserUseService,
} from '../services/browserUseService.js'

const TOOL_ACTIONS = new Set([
  'tabs',
  'navigate',
  'snapshot',
  'act',
  'inspect',
  'takeover',
  'cleanup',
] as const)

export type BrowserUseToolAction =
  | 'tabs'
  | 'navigate'
  | 'snapshot'
  | 'act'
  | 'inspect'
  | 'takeover'
  | 'cleanup'

export function browserUseToolAction(pathname: string): BrowserUseToolAction | null {
  const match = /^\/api\/browser-use\/([^/]+)$/.exec(pathname)
  if (!match) return null
  const action = match[1]!
  return TOOL_ACTIONS.has(action as BrowserUseToolAction)
    ? (action as BrowserUseToolAction)
    : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function readJsonObject(
  req: Request,
  options: { allowEmpty?: boolean } = {},
): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await req.text()
  } catch {
    throw ApiError.badRequest('Failed to read request body')
  }
  if (!raw.trim()) {
    if (options.allowEmpty) return {}
    throw ApiError.badRequest('A JSON object is required')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw ApiError.badRequest('A valid JSON object is required')
  }
  if (!isPlainObject(parsed)) {
    throw ApiError.badRequest('A JSON object is required')
  }
  return parsed
}

const CONFIG_PATCH_KEYS = new Set([
  'enabled',
  'preferredTarget',
  'showCursorOverlay',
  'autoOpenWorkspacePanel',
  'managedChromeHeadless',
  'blockedLoopbackPorts',
  'chromeBinaryPath',
  'chromeUserDataDir',
  'consentAcceptedAt',
])

const PREFERRED_TARGETS = new Set<BrowserPreferredTarget>([
  'auto',
  'workspace',
  'chrome',
])

const DETECTED_BROWSER_IDS = new Set<DetectedBrowserId>([
  'chrome',
  'chrome-canary',
  'edge',
  'brave',
  'chromium',
])

export function parseBrowserUseConfigPatch(
  value: unknown,
): Partial<BrowserUseConfig> | null {
  if (!isPlainObject(value)) return null
  if (Object.keys(value).some(key => !CONFIG_PATCH_KEYS.has(key))) return null

  const patch: Partial<BrowserUseConfig> = {}

  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') return null
    patch.enabled = value.enabled
  }
  if ('preferredTarget' in value) {
    if (
      typeof value.preferredTarget !== 'string' ||
      !PREFERRED_TARGETS.has(value.preferredTarget as BrowserPreferredTarget)
    ) {
      return null
    }
    patch.preferredTarget = value.preferredTarget as BrowserPreferredTarget
  }
  if ('showCursorOverlay' in value) {
    if (typeof value.showCursorOverlay !== 'boolean') return null
    patch.showCursorOverlay = value.showCursorOverlay
  }
  if ('autoOpenWorkspacePanel' in value) {
    if (typeof value.autoOpenWorkspacePanel !== 'boolean') return null
    patch.autoOpenWorkspacePanel = value.autoOpenWorkspacePanel
  }
  if ('managedChromeHeadless' in value) {
    if (typeof value.managedChromeHeadless !== 'boolean') return null
    patch.managedChromeHeadless = value.managedChromeHeadless
  }
  if ('blockedLoopbackPorts' in value) {
    if (
      value.blockedLoopbackPorts !== undefined &&
      (!Array.isArray(value.blockedLoopbackPorts) ||
        value.blockedLoopbackPorts.some(
          port =>
            typeof port !== 'number' ||
            !Number.isInteger(port) ||
            port <= 0 ||
            port > 65535,
        ))
    ) {
      return null
    }
    patch.blockedLoopbackPorts = value.blockedLoopbackPorts as
      | number[]
      | undefined
  }
  if ('chromeBinaryPath' in value) {
    if (
      value.chromeBinaryPath !== undefined &&
      value.chromeBinaryPath !== null &&
      typeof value.chromeBinaryPath !== 'string'
    ) {
      return null
    }
    const trimmed =
      typeof value.chromeBinaryPath === 'string'
        ? value.chromeBinaryPath.trim()
        : ''
    if (trimmed) {
      if (/[;&|`$<>!\r\n\0]/.test(trimmed)) {
        return null
      }
      try {
        if (!statSync(trimmed).isFile()) {
          return null
        }
      } catch {
        return null
      }
    }
    patch.chromeBinaryPath = trimmed
  }
  if ('chromeUserDataDir' in value) {
    if (
      value.chromeUserDataDir !== undefined &&
      value.chromeUserDataDir !== null &&
      typeof value.chromeUserDataDir !== 'string'
    ) {
      return null
    }
    patch.chromeUserDataDir =
      typeof value.chromeUserDataDir === 'string'
        ? value.chromeUserDataDir.trim()
        : ''
  }
  if ('consentAcceptedAt' in value) {
    if (
      value.consentAcceptedAt !== undefined &&
      value.consentAcceptedAt !== null &&
      typeof value.consentAcceptedAt !== 'string'
    ) {
      return null
    }
    patch.consentAcceptedAt =
      typeof value.consentAcceptedAt === 'string'
        ? value.consentAcceptedAt.trim()
        : ''
  }

  return patch
}

function parseOptionalAgentId(body: Record<string, unknown>): string | undefined {
  if (body.agentId === undefined) return undefined
  if (typeof body.agentId !== 'string' || !body.agentId.trim() || body.agentId.length > 200) {
    throw ApiError.badRequest('agentId must be a non-empty string up to 200 chars')
  }
  return body.agentId.trim()
}

function stripMetaFields(body: Record<string, unknown>): Record<string, unknown> {
  const { agentId: _agentId, ...rest } = body
  return rest
}

/**
 * Internal CLI tool endpoint mounted in `src/server/index.ts`.
 * `callerSessionId` MUST be resolved from `authenticateCollaborationCaller()`.
 */
export async function handleBrowserUseToolApi(
  req: Request,
  action: BrowserUseToolAction,
  callerSessionId: string,
  service: BrowserUseService = getBrowserUseService(),
): Promise<Response> {
  try {
    if (req.method !== 'POST') {
      return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 })
    }
    const body = await readJsonObject(req, { allowEmpty: action === 'cleanup' })
    const agentId = parseOptionalAgentId(body)
    const payload = stripMetaFields(body)

    switch (action) {
      case 'tabs': {
        const parsed = browserTabsSchema.safeParse(payload)
        if (!parsed.success) {
          throw ApiError.badRequest(
            parsed.error.issues
              .map(issue => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')
              .slice(0, 1000),
          )
        }
        const result = await service.executeTabs({
          ...parsed.data,
          sessionId: callerSessionId,
          agentId,
          signal: req.signal,
        })
        return Response.json(result)
      }
      case 'navigate': {
        const parsed = browserNavigateSchema.safeParse(payload)
        if (!parsed.success) {
          throw ApiError.badRequest(
            parsed.error.issues
              .map(issue => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')
              .slice(0, 1000),
          )
        }
        const result = await service.executeNavigate({
          ...parsed.data,
          sessionId: callerSessionId,
          agentId,
          signal: req.signal,
        })
        return Response.json(result)
      }
      case 'snapshot': {
        const parsed = browserSnapshotSchema.safeParse(payload)
        if (!parsed.success) {
          throw ApiError.badRequest(
            parsed.error.issues
              .map(issue => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')
              .slice(0, 1000),
          )
        }
        const result = await service.executeSnapshot({
          ...parsed.data,
          sessionId: callerSessionId,
          agentId,
          signal: req.signal,
        })
        return Response.json(result)
      }
      case 'act': {
        const parsed = browserActSchema.safeParse(payload)
        if (!parsed.success) {
          throw ApiError.badRequest(
            parsed.error.issues
              .map(issue => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')
              .slice(0, 1000),
          )
        }
        const result = await service.executeAct({
          ...parsed.data,
          sessionId: callerSessionId,
          agentId,
          signal: req.signal,
        })
        return Response.json(result)
      }
      case 'inspect': {
        const parsed = browserInspectSchema.safeParse(payload)
        if (!parsed.success) {
          throw ApiError.badRequest(
            parsed.error.issues
              .map(issue => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')
              .slice(0, 1000),
          )
        }
        const result = await service.executeInspect({
          ...parsed.data,
          sessionId: callerSessionId,
          agentId,
          signal: req.signal,
        })
        return Response.json(result)
      }
      case 'takeover': {
        const parsed = browserTakeoverSchema.safeParse(payload)
        if (!parsed.success) {
          throw ApiError.badRequest(
            parsed.error.issues
              .map(issue => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')
              .slice(0, 1000),
          )
        }
        const result = await service.executeTakeover({
          ...parsed.data,
          sessionId: callerSessionId,
          agentId,
        })
        return Response.json(result)
      }
      case 'cleanup': {
        const result = await service.cleanupAfterTurn({
          sessionId: callerSessionId,
          agentId,
        })
        return Response.json(result)
      }
    }
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * Desktop UI / Settings REST surface mounted in `src/server/router.ts`.
 * Strictly excluded from `src/server/publicAccess.ts`.
 */
export async function handleBrowserUseUiApi(
  req: Request,
  _url: URL,
  segments: string[],
  service: BrowserUseService = getBrowserUseService(),
): Promise<Response> {
  try {
    const resource = segments[2]
    const subAction = segments[3]

    if (resource === 'status' && !subAction && req.method === 'GET') {
      return Response.json(await service.getStatus())
    }

    if (resource === 'config' && !subAction) {
      if (req.method === 'GET') {
        return Response.json(service.getConfig())
      }
      if (req.method === 'PUT') {
        const body = await readJsonObject(req)
        const patch = parseBrowserUseConfigPatch(body)
        if (!patch) {
          throw ApiError.badRequest('Invalid Browser Use configuration patch')
        }
        return Response.json(service.updateConfig(patch))
      }
    }

    if (resource === 'chrome' && req.method === 'POST') {
      if (subAction === 'connect') {
        const body = await readJsonObject(req, { allowEmpty: true })
        const browserId =
          typeof body.browserId === 'string' &&
          DETECTED_BROWSER_IDS.has(body.browserId as DetectedBrowserId)
            ? (body.browserId as DetectedBrowserId)
            : undefined
        const timeoutMs =
          typeof body.timeoutMs === 'number' &&
          Number.isFinite(body.timeoutMs) &&
          body.timeoutMs >= 1_000 &&
          body.timeoutMs <= 60_000
            ? Math.floor(body.timeoutMs)
            : undefined
        const result = await service.connectChrome({ browserId, timeoutMs })
        return Response.json({
          ok: result.chrome.mode === 'live_attach',
          chrome: result.chrome,
          status: result.status,
          ...(result.chrome.error ? { error: result.chrome.error } : {}),
        })
      }

      if (subAction === 'launch-managed') {
        const body = await readJsonObject(req, { allowEmpty: true })
        const browserId =
          typeof body.browserId === 'string' &&
          DETECTED_BROWSER_IDS.has(body.browserId as DetectedBrowserId)
            ? (body.browserId as DetectedBrowserId)
            : undefined
        const headless =
          typeof body.headless === 'boolean' ? body.headless : undefined
        const result = await service.launchManagedChrome({ browserId, headless })
        return Response.json({
          ok: result.chrome.mode === 'managed',
          chrome: result.chrome,
          status: result.status,
          ...(result.chrome.error ? { error: result.chrome.error } : {}),
        })
      }

      if (subAction === 'disconnect') {
        const status = await service.disconnectChrome()
        return Response.json({ ok: true, status })
      }
    }

    if (resource === 'takeover' && req.method === 'POST') {
      if (subAction === 'resume') {
        const body = await readJsonObject(req)
        const sessionId =
          typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId || sessionId.length > 200) {
          throw ApiError.badRequest('sessionId is required')
        }
        const takeoverId =
          typeof body.takeoverId === 'string' && body.takeoverId.trim()
            ? body.takeoverId.trim()
            : undefined
        const note =
          typeof body.note === 'string' && body.note.trim()
            ? body.note.trim().slice(0, 1000)
            : undefined
        const result = await service.resumeTakeover({
          sessionId,
          takeoverId,
          note,
        })
        return Response.json({ ok: true, ...result })
      }

      if (subAction === 'abort') {
        const body = await readJsonObject(req)
        const sessionId =
          typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId || sessionId.length > 200) {
          throw ApiError.badRequest('sessionId is required')
        }
        const takeoverId =
          typeof body.takeoverId === 'string' && body.takeoverId.trim()
            ? body.takeoverId.trim()
            : undefined
        const reason =
          typeof body.reason === 'string' && body.reason.trim()
            ? body.reason.trim().slice(0, 500)
            : undefined
        const result = await service.abortTakeover({
          sessionId,
          takeoverId,
          reason,
        })
        return Response.json({ ok: true, ...result })
      }
    }

    throw ApiError.notFound('Unknown Browser Use API route')
  } catch (error) {
    return errorResponse(error)
  }
}
