/**
 * Desktop UI Preferences REST API
 *
 * GET  /api/desktop-ui/preferences          — read cc-haha UI preferences
 * PUT  /api/desktop-ui/preferences/sidebar  — persist sidebar project preferences
 * PUT  /api/desktop-ui/preferences/project-display-name — set or reset one project display name
 * GET  /api/desktop-ui/preferences/profile  — read profile identity and inline avatar
 * PUT  /api/desktop-ui/preferences/profile  — persist local profile preferences
 * GET  /api/desktop-ui/preferences/pet      — read only desktop pet preferences
 * PUT  /api/desktop-ui/preferences/pet      — patch desktop pet preferences
 * GET  /api/desktop-ui/preferences/profile/avatar — read local profile avatar
 * PUT  /api/desktop-ui/preferences/profile/avatar — persist local profile avatar
 * DELETE /api/desktop-ui/preferences/profile/avatar — reset local profile avatar
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { DesktopUiPreferencesService } from '../services/desktopUiPreferencesService.js'
import { isPetAccessAuthorized } from '../localAccessAuth.js'

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

    if (detail === 'project-display-name') {
      if (req.method !== 'PUT') throw methodNotAllowed(req.method)
      const body = await parseJsonBody(req)
      const update = await desktopUiPreferencesService.updateProjectDisplayName(body)
      return Response.json({ ok: true, ...update })
    }

    if (detail === 'pet') {
      if (req.method === 'GET') {
        const result = await desktopUiPreferencesService.readPreferences()
        return Response.json({
          exists: result.exists,
          pet: result.preferences.pet,
        })
      }
      if (req.method !== 'PUT') throw methodNotAllowed(req.method)
      const body = await parseJsonBody(req)
      const preferences = await desktopUiPreferencesService.updatePetPreferences(body)
      if (isPetAccessAuthorized(req)) {
        return Response.json({ ok: true, pet: preferences.pet })
      }
      return Response.json({
        ok: true,
        preferences,
      })
    }

    if (detail === 'profile') {
      const action = segments[4]

      if (action === undefined) {
        if (req.method === 'GET') {
          return Response.json({ profile: await desktopUiPreferencesService.readProfileSummary() }, {
            headers: { 'Cache-Control': 'no-store' },
          })
        }
        if (req.method !== 'PUT') throw methodNotAllowed(req.method)
        const body = await parseJsonBody(req)
        return Response.json({
          ok: true,
          preferences: await desktopUiPreferencesService.updateProfilePreferences(body),
        })
      }

      if (action === 'avatar') {
        if (req.method === 'GET') {
          const avatar = await desktopUiPreferencesService.readProfileAvatar()
          if (!avatar) {
            throw ApiError.notFound('Profile avatar is not configured')
          }
          return new Response(avatar.bytes, {
            headers: {
              'Content-Type': avatar.contentType,
              'Cache-Control': 'no-store',
            },
          })
        }

        if (req.method === 'PUT') {
          const bytes = new Uint8Array(await req.arrayBuffer())
          return Response.json({
            ok: true,
            preferences: await desktopUiPreferencesService.updateProfileAvatar(
              bytes,
              req.headers.get('Content-Type'),
            ),
          })
        }

        if (req.method === 'DELETE') {
          return Response.json({
            ok: true,
            preferences: await desktopUiPreferencesService.clearProfileAvatar(),
          })
        }

        throw methodNotAllowed(req.method)
      }

      throw ApiError.notFound(`Unknown desktop UI profile endpoint: ${action}`)
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
