import { z } from 'zod/v4'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import {
  PromptOptimizeService,
  promptOptimizeInputSchema,
} from '../services/promptOptimizeService.js'
import { ensureCliSessionStartedForControl } from '../ws/handler.js'
import { ApiError } from '../middleware/errorHandler.js'

const service = new PromptOptimizeService({
  ensure: ensureCliSessionStartedForControl,
  control: (id, request, timeout, signal) =>
    conversationService.requestControl(id, request, timeout, signal),
})

export const hasPromptOptimizePowerActivity = () => service.hasPendingWork()

const MAX_BODY_BYTES = 256 * 1024

async function readBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader()
  if (!reader) throw ApiError.badRequest('JSON body is required')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new ApiError(
          413,
          'Prompt optimization body is too large',
          'BODY_TOO_LARGE',
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

export async function handlePromptOptimizeRoute(
  req: Request,
  url: URL,
  sessionId: string,
  requestId?: string,
): Promise<Response> {
  if (!conversationService.hasSession(sessionId)) {
    const summary = await sessionService.getSessionSummary(sessionId)
    if (!summary) throw ApiError.notFound(`Session not found: ${sessionId}`)
  }
  if (req.method === 'POST' && requestId === undefined) {
    const parsed = promptOptimizeInputSchema.safeParse(await readBody(req))
    if (!parsed.success) {
      throw ApiError.badRequest(
        'Invalid prompt optimization request: requestId UUID and nonempty prompt are required',
      )
    }
    return Response.json(
      await service.optimize(sessionId, parsed.data, url, req.signal),
    )
  }
  if (req.method === 'DELETE' && requestId !== undefined) {
    if (!z.uuid().safeParse(requestId).success) {
      throw ApiError.badRequest('Invalid requestId')
    }
    return Response.json({
      requestId,
      cancelled: await service.cancel(sessionId, requestId),
    })
  }
  return Response.json(
    {
      error: 'METHOD_NOT_ALLOWED',
      message: 'Unsupported prompt optimization route',
    },
    { status: 405 },
  )
}
