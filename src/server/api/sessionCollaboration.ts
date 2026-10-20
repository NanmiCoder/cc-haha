import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
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

const identifier = z.string().trim().min(1).max(200)
const runtimeSchema = z.strictObject({
  providerId: identifier.nullable(), modelId: identifier,
  effortLevel: z.string().min(1).max(30).optional(), openAIFastMode: z.boolean().optional(),
})
const delegationEntrySchema = z.strictObject({
  id: identifier.optional(), prompt: z.string().trim().min(1).max(32_000),
  title: z.string().max(200).optional(), workDir: z.string().max(4096).optional(),
  runtime: runtimeSchema.optional(), model: identifier.optional(), providerId: identifier.nullable().optional(),
  userInstruction: z.strictObject({ messageId: identifier, quote: z.string().trim().min(1).max(4000) }).optional(),
  requestId: z.undefined().optional(),
}).refine(value => !value.runtime || (value.model === undefined && value.providerId === undefined), 'Use runtime or legacy model/providerId, not both')
const delegationSchema = z.strictObject({ requestId: identifier, sessions: z.array(delegationEntrySchema).min(1).max(8) })
const revisionSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative() })
const updateSchema = revisionSchema.extend({ selections: z.array(z.strictObject({ id: identifier, runtime: runtimeSchema })).min(1).max(8) })
const changeSchema = z.strictObject({
  requestId: identifier, mode: z.enum(['after_turn', 'immediate']).optional(), resume: z.boolean().optional(),
  selections: z.array(z.strictObject({ sessionId: identifier, runtime: runtimeSchema })).min(1).max(8),
})
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 2000))
  return parsed.data
}
async function jsonBody(req: Request): Promise<unknown> {
  try { return await req.json() } catch { throw ApiError.badRequest('A JSON object is required') }
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
      case 'models': return Response.json({ models: await service.getModels() })
      case 'create':
      case 'create-batch': {
        const input = parse(delegationSchema, action === 'create'
          ? { requestId: body.requestId ?? randomUUID(), sessions: [{ ...body, requestId: undefined }] }
          : body)
        const batch = await service.propose(callerSessionId, input)
        return Response.json({ ...batch, requiresReview: batch.state === 'review' || batch.state === 'failed' })
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
    const parts = url.pathname.split('/').filter(Boolean).slice(2).map(part => { try { return decodeURIComponent(part) } catch { throw ApiError.badRequest('Invalid path encoding') } })
    if (!parts.length && req.method === 'GET') return Response.json(await service.candidates(url.searchParams.get('query') || undefined, req.signal))
    const sessionId = parts[0]
    if (!sessionId) throw ApiError.notFound('Session id required')
    if (parts.length === 2 && parts[1] === 'delegation' && req.method === 'GET') {
      const [batches, models, changes, status, sessions] = await Promise.all([service.listBatches(sessionId), service.getModels(), service.listModelChanges(sessionId), service.groupStatus(sessionId), service.getMemberRuntimes(sessionId)])
      return Response.json({ batches, models, changes, status, sessions })
    }
    if (parts.length === 4 && parts[1] === 'batches' && req.method === 'POST') {
      const body = await jsonBody(req)
      const batchId = parts[2]!
      if (parts[3] === 'update') {
        const input = parse(updateSchema, body)
        return Response.json(await service.updateBatch(sessionId, batchId, input.expectedRevision, input.selections))
      }
      const input = parse(revisionSchema, body)
      // The dialog closes on this response; the launch reports through the batch's state.
      if (parts[3] === 'confirm') return Response.json(await service.confirmBatch(sessionId, batchId, input.expectedRevision, { wait: false }))
      if (parts[3] === 'cancel') return Response.json(await service.cancelBatch(sessionId, batchId, input.expectedRevision))
    }
    if (parts.length === 2 && parts[1] === 'model-changes' && req.method === 'POST') {
      return Response.json(await service.changeModels(sessionId, parse(changeSchema, await jsonBody(req)), { wait: false }))
    }
    if (parts.length === 4 && parts[1] === 'model-changes' && parts[3] === 'cancel' && req.method === 'POST') {
      const input = parse(revisionSchema, await jsonBody(req))
      return Response.json(await service.cancelModelChange(sessionId, parts[2]!, input.expectedRevision))
    }
    if (parts.length === 2 && parts[1] === 'status' && req.method === 'GET') return Response.json(await service.groupStatus(sessionId))
    if (parts.length === 2 && parts[1] === 'stop' && req.method === 'POST') { await service.stopGroup(sessionId); return Response.json({ ok: true }) }
    if (parts.length === 2 && parts[1] === 'resume' && req.method === 'POST') { await service.resume(sessionId); return Response.json({ ok: true }) }
    throw ApiError.notFound('Unknown session collaboration UI route')
  } catch (error) { return errorResponse(error) }
}
