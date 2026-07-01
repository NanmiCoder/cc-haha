import type { PluginScope } from '../../utils/plugins/schemas.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { PluginService } from '../services/pluginService.js'
import {
  clearKnownLanguageServerCache,
  getKnownLanguageServerStatuses,
} from '../services/knownLanguageServers.js'
import { conversationService } from '../services/conversationService.js'
import { updateSessionSlashCommands } from '../ws/handler.js'
import {
  loadPluginOptions,
  savePluginOptions,
  clearPluginOptionsCache,
} from '../../utils/plugins/pluginOptionsStorage.js'
import type { PluginManifest } from '../../utils/plugins/schemas.js'

const pluginService = new PluginService()

type PluginSessionReloadSummary = {
  applied: boolean
  reason?: 'not_running' | 'failed'
  commands: number
  agents: number
  plugins: number
  mcpServers: number
  errors: number
  error?: string
}

export async function handlePluginsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const sub = segments[2]
    const cwd = url.searchParams.get('cwd') || undefined

    if (method === 'GET' && !sub) {
      return Response.json(await pluginService.listPlugins(cwd))
    }

    if (method === 'GET' && sub === 'catalog') {
      return Response.json({
        catalog: await pluginService.getCatalog(),
      })
    }

    if (method === 'GET' && sub === 'detail') {
      const pluginId = url.searchParams.get('id')
      if (!pluginId) {
        throw ApiError.badRequest('Missing required "id" query parameter')
      }
      return Response.json({
        detail: await pluginService.getPluginDetail(pluginId, cwd),
      })
    }

    if (method === 'GET' && sub === 'prerequisites') {
      const pluginId = url.searchParams.get('id')
      if (!pluginId) {
        throw ApiError.badRequest('Missing required "id" query parameter')
      }
      return Response.json(
        await pluginService.checkPluginPrerequisites(pluginId, cwd),
      )
    }

    if (method === 'GET' && sub === 'options') {
      const pluginId = url.searchParams.get('id')
      if (!pluginId) {
        throw ApiError.badRequest('Missing required "id" query parameter')
      }
      const detail = await pluginService.getPluginDetail(pluginId, cwd)
      const userConfig = (detail as Record<string, unknown>).userConfig as PluginManifest['userConfig'] | undefined
      const options = loadPluginOptions(pluginId)
      // Mask sensitive values — frontend only needs to know they exist
      const masked: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(options)) {
        if (userConfig?.[key]?.sensitive === true) {
          masked[key] = typeof value === 'string' && value.length > 0 ? '********' : ''
        } else {
          masked[key] = value
        }
      }
      return Response.json({
        pluginId,
        schema: userConfig ?? {},
        values: masked,
      })
    }

    if (method === 'POST' && sub === 'options') {
      const body = await parseJsonBody(req)
      const pluginId = asString(body.id)
      if (!pluginId) {
        throw ApiError.badRequest('Missing required "id" field')
      }
      const values = body.values as Record<string, unknown> | undefined
      if (!values || typeof values !== 'object') {
        throw ApiError.badRequest('Missing required "values" field')
      }
      const detail = await pluginService.getPluginDetail(pluginId, cwd)
      const userConfig = (detail as Record<string, unknown>).userConfig as PluginManifest['userConfig'] | undefined
      if (!userConfig || Object.keys(userConfig).length === 0) {
        throw ApiError.badRequest('Plugin has no userConfig options')
      }
      // Filter to only schema-declared keys (prevent injection of arbitrary keys)
      const filtered: Record<string, unknown> = {}
      for (const key of Object.keys(userConfig)) {
        if (key in values) {
          filtered[key] = values[key]
        }
      }
      savePluginOptions(pluginId, filtered, userConfig)
      clearPluginOptionsCache()
      return Response.json({ ok: true, pluginId })
    }

    if (method === 'GET' && sub === 'language-servers') {
      if (url.searchParams.get('refresh')) {
        clearKnownLanguageServerCache()
      }
      return Response.json({
        servers: await getKnownLanguageServerStatuses(),
      })
    }

    if (method === 'POST' && sub === 'reload') {
      const sessionId = url.searchParams.get('sessionId') || undefined
      const response = await pluginService.reloadPlugins(cwd)
      if (!sessionId) {
        return Response.json(response)
      }

      return Response.json({
        ...response,
        session: await reloadSessionPlugins(sessionId),
      })
    }

    if (method === 'POST' && sub === 'install') {
      const body = await parseJsonBody(req)
      const id = asString(body.id)
      const marketplace = asString(body.marketplace)
      if (!id || !marketplace) {
        throw ApiError.badRequest(
          'Missing required fields: "id" and "marketplace"',
        )
      }
      return Response.json(
        await pluginService.installCatalogPlugin(id, marketplace),
      )
    }

    if (method === 'POST' && sub === 'marketplace') {
      const body = await parseJsonBody(req)
      const input = asString(body.input)
      if (!input) {
        throw ApiError.badRequest('Missing required field: "input"')
      }
      return Response.json(await pluginService.addMarketplaceFromInput(input))
    }

    if (method === 'POST' && sub) {
      const body = await parseJsonBody(req)
      const pluginId = asString(body.id)
      if (!pluginId) {
        throw ApiError.badRequest('Missing or invalid "id" in request body')
      }

      const scope = coerceScope(body.scope)

      switch (sub) {
        case 'enable':
          return Response.json(await pluginService.enablePlugin(pluginId, scope))
        case 'disable':
          return Response.json(await pluginService.disablePlugin(pluginId, scope))
        case 'update':
          return Response.json(
            await pluginService.updatePlugin(pluginId, scope as PluginScope | undefined),
          )
        case 'uninstall':
          return Response.json(
            await pluginService.uninstallPlugin(
              pluginId,
              scope,
              body.keepData === true,
            ),
          )
        default:
          throw ApiError.notFound(`Unknown plugins endpoint: ${sub}`)
      }
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/plugins${sub ? `/${sub}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

async function reloadSessionPlugins(
  sessionId: string,
): Promise<PluginSessionReloadSummary> {
  if (!conversationService.hasSession(sessionId)) {
    return {
      applied: false,
      reason: 'not_running',
      commands: 0,
      agents: 0,
      plugins: 0,
      mcpServers: 0,
      errors: 0,
    }
  }

  try {
    const response = await conversationService.requestControl(
      sessionId,
      { subtype: 'reload_plugins' },
      120_000,
    )
    const commands = Array.isArray(response.commands) ? response.commands : []
    const normalizedCommands = updateSessionSlashCommands(sessionId, commands)

    return {
      applied: true,
      commands: normalizedCommands.length,
      agents: Array.isArray(response.agents) ? response.agents.length : 0,
      plugins: Array.isArray(response.plugins) ? response.plugins.length : 0,
      mcpServers: Array.isArray(response.mcpServers) ? response.mcpServers.length : 0,
      errors: typeof response.error_count === 'number' ? response.error_count : 0,
    }
  } catch (error) {
    return {
      applied: false,
      reason: 'failed',
      commands: 0,
      agents: 0,
      plugins: 0,
      mcpServers: 0,
      errors: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function coerceScope(value: unknown):
  | 'user'
  | 'project'
  | 'local'
  | 'managed'
  | undefined {
  if (value == null) return undefined
  if (
    value === 'user' ||
    value === 'project' ||
    value === 'local' ||
    value === 'managed'
  ) {
    return value
  }
  throw ApiError.badRequest(
    'Invalid "scope". Expected one of: user, project, local, managed',
  )
}
