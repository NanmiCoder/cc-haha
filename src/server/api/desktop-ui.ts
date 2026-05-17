/**
 * Desktop UI Preferences REST API
 *
 * GET  /api/desktop-ui/preferences          — read cc-haha UI preferences
 * PUT  /api/desktop-ui/preferences/sidebar  — persist sidebar project preferences
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { DesktopUiPreferencesService } from '../services/desktopUiPreferencesService.js'

const desktopUiPreferencesService = new DesktopUiPreferencesService()

export async function handleDesktopUiApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  void url

  try {
    const sub = segments[2]
    const detail = segments[3]

    if (sub !== 'preferences') {
      throw ApiError.notFound(`Unknown desktop UI endpoint: ${sub}`)
    }

    if (detail === undefined) {
      if (req.method !== 'GET') throw methodNotAllowed(req.method)
      return Response.json(await desktopUiPreferencesService.readPreferences())
    }

    if (detail === 'sidebar') {
      if (req.method !== 'PUT') throw methodNotAllowed(req.method)
      const body = await parseJsonBody(req)
      return Response.json({
        ok: true,
        preferences: await desktopUiPreferencesService.updateSidebarPreferences(body),
      })
    }

    throw ApiError.notFound(`Unknown desktop UI preferences endpoint: ${detail}`)
  } catch (error) {
    return errorResponse(error)
  }
}

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
