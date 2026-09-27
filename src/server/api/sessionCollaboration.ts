import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import type { SessionCollaborationService } from '../services/sessionCollaborationService.js'

function stringField(body: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = body[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 32_000) throw ApiError.badRequest(`${name} must be a nonempty string of at most 32000 characters`)
  return value
}
function numberField(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw ApiError.badRequest(`${name} must be a nonnegative integer`)
  return value
}

/** callerSessionId must be resolved from the authenticated SDK token by the host router. */
export async function handleSessionCollaborationApi(req: Request, action: string, callerSessionId: string, service: SessionCollaborationService): Promise<Response> {
  try {
    if (req.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 })
    let body: Record<string, unknown>
    try {
      const value = await req.json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
      body = value
    } catch { throw ApiError.badRequest('A JSON object is required') }
    switch (action) {
      case 'list': return Response.json(await service.list({ query: stringField(body, 'query'), limit: numberField(body, 'limit'), offset: numberField(body, 'offset'), signal: req.signal }))
      case 'read': return Response.json(await service.read(stringField(body, 'sessionId', true)!, {
        cursor: stringField(body, 'cursor'), limit: numberField(body, 'limit'), signal: req.signal,
        includeOutputs: body.includeOutputs === true, maxOutputCharsPerItem: numberField(body, 'maxOutputCharsPerItem'),
      }))
      case 'create': {
        if (body.providerId !== undefined && body.providerId !== null && typeof body.providerId !== 'string') throw ApiError.badRequest('providerId must be a string or null')
        return Response.json(await service.create(callerSessionId, {
          prompt: stringField(body, 'prompt', true)!, requestId: stringField(body, 'requestId'), title: stringField(body, 'title'),
          workDir: stringField(body, 'workDir'), model: stringField(body, 'model'),
          ...(body.providerId !== undefined ? { providerId: body.providerId as string | null } : {}),
        }))
      }
      case 'send': return Response.json(await service.send(callerSessionId, stringField(body, 'targetSessionId', true)!, stringField(body, 'content', true)!, stringField(body, 'messageId')))
      case 'wait': {
        if (body.sessionIds !== undefined && (!Array.isArray(body.sessionIds) || body.sessionIds.length > 8 || body.sessionIds.some(id => typeof id !== 'string' || !id))) throw ApiError.badRequest('sessionIds must contain at most eight session ids')
        const revision = numberField(body, 'afterRevision') ?? (await service.status()).revision
        return Response.json(await service.wait(revision, body.sessionIds as string[] | undefined, numberField(body, 'timeoutMs'), req.signal, callerSessionId))
      }
      default: throw ApiError.notFound('Unknown session collaboration action')
    }
  } catch (error) { return errorResponse(error) }
}

/** The host router must protect this UI surface with desktop/global authentication. */
export async function handleSessionCollaborationUiApi(req: Request, url: URL, service: SessionCollaborationService): Promise<Response> {
  try {
    const parts = url.pathname.split('/').filter(Boolean).slice(2)
    if (!parts.length && req.method === 'GET') return Response.json(await service.candidates(url.searchParams.get('query') || undefined, req.signal))
    const sessionId = parts[0]
    if (!sessionId) throw ApiError.notFound('Session id required')
    if (parts.length === 2 && parts[1] === 'status' && req.method === 'GET') return Response.json(await service.groupStatus(sessionId))
    if (parts.length === 2 && parts[1] === 'stop' && req.method === 'POST') { await service.stopGroup(sessionId); return Response.json({ ok: true }) }
    if (parts.length === 2 && parts[1] === 'resume' && req.method === 'POST') { await service.resume(sessionId); return Response.json({ ok: true }) }
    throw ApiError.notFound('Unknown session collaboration UI route')
  } catch (error) { return errorResponse(error) }
}
