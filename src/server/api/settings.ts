/**
 * Settings REST API
 *
 * GET  /api/settings            — 获取合并后的设置
 * GET  /api/settings/user       — 获取用户设置
 * GET  /api/settings/project    — 获取项目设置
 * PUT  /api/settings/user       — 更新用户设置
 * PUT  /api/settings/project    — 更新项目设置
 * POST /api/settings/session-cleanup — 按指定保留天数清理会话记录（可 dryRun 预览）
 * GET  /api/permissions/mode    — 获取权限模式
 * PUT  /api/permissions/mode    — 设置权限模式
 */

import { SettingsService } from '../services/settingsService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { ensureDesktopCliLauncherInstalled } from '../services/desktopCliLauncherService.js'
import { conversationService } from '../services/conversationService.js'
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  getAllOutputStyles,
  type OutputStyleConfig,
} from '../../constants/outputStyles.js'
import { getCwd } from '../../utils/cwd.js'
import { cleanupOldSessionFiles } from '../../utils/cleanup.js'

const settingsService = new SettingsService()

/** Upper bound for the retention input; 10 years is effectively "forever". */
const MAX_SESSION_RETENTION_DAYS = 3650
const MS_PER_DAY = 24 * 60 * 60 * 1000

type OutputStyleSource =
  | OutputStyleConfig['source']
  | 'built-in'

type OutputStyleListItem = {
  value: string
  label: string
  description: string
  source: OutputStyleSource
}

const DEFAULT_OUTPUT_STYLE_LABEL = 'Default'
const DEFAULT_OUTPUT_STYLE_DESCRIPTION =
  'Claude completes coding tasks efficiently and provides concise responses'

export async function handleSettingsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const resource = segments[1] // 'settings' | 'permissions'
    const sub = segments[2] // 'user' | 'project' | 'mode' | undefined

    // ── /api/permissions/* ──────────────────────────────────────────────
    if (resource === 'permissions') {
      if (sub === 'mode') {
        return await handlePermissionMode(req)
      }
      throw ApiError.notFound(`Unknown permissions endpoint: ${sub}`)
    }

    // ── /api/settings/* ─────────────────────────────────────────────────
    const method = req.method

    switch (sub) {
      case undefined:
        // GET /api/settings
        if (method !== 'GET') throw methodNotAllowed(method)
        return Response.json(await settingsService.getSettings())

      case 'user':
        return await handleUserSettings(req)

      case 'project':
        return await handleProjectSettings(req, url)

      case 'output-styles':
        return await handleOutputStyles(req, url)

      case 'output-style':
        return await handleOutputStyle(req)

      case 'session-cleanup':
        return await handleSessionCleanup(req)

      case 'cli-launcher':
        if (method !== 'GET') throw methodNotAllowed(method)
        return Response.json(await ensureDesktopCliLauncherInstalled())

      default:
        throw ApiError.notFound(`Unknown settings endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleUserSettings(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json(await settingsService.getUserSettings())
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    await settingsService.updateUserSettings(body)
    syncThinkingSettingToActiveSessions(body)
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

async function handleProjectSettings(req: Request, url: URL): Promise<Response> {
  const projectRoot = url.searchParams.get('projectRoot') || undefined

  if (req.method === 'GET') {
    return Response.json(await settingsService.getProjectSettings(projectRoot))
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    await settingsService.updateProjectSettings(body, projectRoot)
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

async function handleOutputStyles(req: Request, url: URL): Promise<Response> {
  if (req.method !== 'GET') {
    throw methodNotAllowed(req.method)
  }

  const workDir = getWorkDirFromUrl(url)
  const styles = await listOutputStyles(workDir)
  const settings = workDir
    ? Object.assign(
        {},
        await settingsService.getUserSettings(),
        await settingsService.getProjectSettings(workDir).catch(() => ({})),
        await settingsService.getLocalSettings(workDir).catch(() => ({})),
      )
    : await settingsService.getUserSettings()
  const outputStyle =
    typeof settings.outputStyle === 'string'
      ? settings.outputStyle
      : DEFAULT_OUTPUT_STYLE_NAME

  return Response.json({
    outputStyle,
    styles,
    scope: workDir ? 'localSettings' : 'userSettings',
    workDir: workDir ?? null,
  })
}

async function handleOutputStyle(req: Request): Promise<Response> {
  if (req.method !== 'PUT') {
    throw methodNotAllowed(req.method)
  }

  const body = await parseJsonBody(req)
  const outputStyle = body.outputStyle
  if (typeof outputStyle !== 'string' || outputStyle.trim().length === 0) {
    throw ApiError.badRequest('Missing or invalid "outputStyle" in request body')
  }

  const workDir =
    typeof body.workDir === 'string' && body.workDir.trim().length > 0
      ? body.workDir
      : undefined
  const styles = await listOutputStyles(workDir)
  if (!styles.some(style => style.value === outputStyle)) {
    throw ApiError.badRequest(`Unknown output style: "${outputStyle}"`)
  }

  if (workDir) {
    await settingsService.updateLocalSettings({ outputStyle }, workDir)
    return Response.json({
      ok: true,
      outputStyle,
      scope: 'localSettings',
      workDir,
    })
  }

  await settingsService.updateUserSettings({ outputStyle })
  return Response.json({
    ok: true,
    outputStyle,
    scope: 'userSettings',
    workDir: null,
  })
}

/**
 * Run (or preview) transcript cleanup with an explicit retention window.
 *
 * The desktop writes `cleanupPeriodDays` through this same service, so we take
 * `days` from the request rather than reading it back: the CLI refreshes its
 * settings cache from a file watcher, so a read-back could still race the write.
 */
async function handleSessionCleanup(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    throw methodNotAllowed(req.method)
  }

  const body = await parseJsonBody(req)
  const days = body.days
  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < 0 ||
    days > MAX_SESSION_RETENTION_DAYS
  ) {
    throw ApiError.badRequest(
      `"days" must be an integer between 0 and ${MAX_SESSION_RETENTION_DAYS}`,
    )
  }

  const dryRun = body.dryRun === true
  const cutoffDate = new Date(Date.now() - days * MS_PER_DAY)
  const result = await cleanupOldSessionFiles(cutoffDate, { dryRun })

  return Response.json({
    ok: true,
    days,
    dryRun,
    files: result.messages,
    errors: result.errors,
  })
}

async function handlePermissionMode(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const mode = await settingsService.getPermissionMode()
    return Response.json({ mode })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const mode = body.mode
    if (typeof mode !== 'string') {
      throw ApiError.badRequest('Missing or invalid "mode" in request body')
    }
    await settingsService.setPermissionMode(mode)
    return Response.json({ ok: true, mode })
  }

  throw methodNotAllowed(req.method)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}

function getWorkDirFromUrl(url: URL): string | undefined {
  const raw = url.searchParams.get('workDir')
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw
  }
  return undefined
}

async function listOutputStyles(workDir?: string): Promise<OutputStyleListItem[]> {
  const cwd = workDir ?? getCwd()
  const styles = await getAllOutputStyles(cwd)
  return Object.entries(styles).map(([value, config]) => ({
    value,
    label: config?.name ?? DEFAULT_OUTPUT_STYLE_LABEL,
    description: config?.description ?? DEFAULT_OUTPUT_STYLE_DESCRIPTION,
    source: config?.source ?? 'built-in',
  }))
}

function syncThinkingSettingToActiveSessions(settings: Record<string, unknown>): void {
  if (
    !Object.prototype.hasOwnProperty.call(settings, 'alwaysThinkingEnabled') ||
    typeof settings.alwaysThinkingEnabled !== 'boolean'
  ) {
    return
  }

  conversationService.setMaxThinkingTokensForActiveSessions(
    settings.alwaysThinkingEnabled ? null : 0,
  )
}
