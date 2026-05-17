import { openTargetService } from '../services/openTargetService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

export async function handleOpenTargetsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const action = segments[2]

    if (!action) {
      if (req.method !== 'GET') {
        throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
      }

      return Response.json(await openTargetService.listTargets())
    }

    if (action === 'open') {
      if (req.method !== 'POST') {
        throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
      }

      const body = await parseJsonBody(req)
      const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : ''
      const path = typeof body.path === 'string' ? body.path : ''

      if (!targetId) {
        throw ApiError.badRequest('Missing or invalid "targetId" in request body')
      }

      if (!path || !path.trim()) {
        throw ApiError.badRequest('Missing or invalid "path" in request body')
      }

      return Response.json(await openTargetService.openTarget({ targetId, path }))
    }

    if (action === 'icons') {
      if (req.method !== 'GET') {
        throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
      }

      const targetId = typeof segments[3] === 'string' ? decodeURIComponent(segments[3]).trim() : ''
      if (!targetId) {
        throw ApiError.badRequest('Missing open target icon id')
      }

      const icon = await openTargetService.getTargetIcon(targetId)
      return new Response(icon.data, {
        headers: {
          'Cache-Control': 'private, max-age=86400',
          'Content-Type': icon.contentType,
        },
      })
    }

    throw ApiError.notFound(`Unknown open-targets endpoint: ${action}`)
  } catch (error) {
    return errorResponse(error)
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}
