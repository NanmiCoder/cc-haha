import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import type { ApiRequestContext } from '../remoteBrowserPolicy.js'
import { getMobilePushService } from '../services/mobilePushRuntime.js'
import { validatePushInput, type MobilePushService } from '../services/mobilePushService.js'

export async function handleMobilePushApi(req: Request, segments: string[], context: ApiRequestContext, service: MobilePushService = getMobilePushService()) {
  try {
    if (segments.length === 3 && req.method === 'GET') return Response.json(service.status())
    if (segments.length !== 3 && segments.length !== 4) throw ApiError.notFound('Mobile push route not found')
    if (req.method !== 'PUT' && req.method !== 'DELETE') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 })
    const raw = await req.text()
    if (raw.length > 16384) throw ApiError.badRequest('Mobile push registration is too large')
    let body: unknown
    try { body = JSON.parse(raw) } catch { throw ApiError.badRequest('Invalid push registration') }
    if (segments.length === 3 && req.method === 'PUT') {
      if (!validatePushInput(body)) throw ApiError.badRequest('Invalid push registration')
      return Response.json(service.register(body, context))
    }
    if (segments.length === 3 && req.method === 'DELETE') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || typeof (body as Record<string, unknown>).token !== 'string' || typeof (body as Record<string, unknown>).hostId !== 'string') throw ApiError.badRequest('Device token and host ID required')
      const input = body as { token: string; hostId: string }
      return Response.json({ removed: service.unregisterDevice(input.token, input.hostId, context) })
    }
    if (segments.length === 4 && req.method === 'DELETE') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as Record<string, unknown>).token !== 'string') throw ApiError.badRequest('Device token required')
      const removed = service.unregister(segments[3]!, (body as { token: string }).token, context)
      return Response.json({ removed }, { status: removed ? 200 : 404 })
    }
    return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 })
  } catch (error) { return errorResponse(error) }
}
