import { z } from 'zod/v4'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import { SideQuestionService, sideQuestionInputSchema } from '../services/sideQuestionService.js'
import { ensureCliSessionStartedForControl } from '../ws/handler.js'
import { ApiError } from '../middleware/errorHandler.js'

const service = new SideQuestionService({
  ensure: ensureCliSessionStartedForControl,
  control: (id, request, timeout, signal) => conversationService.requestControl(id, request, timeout, signal),
})
const MAX_BODY_BYTES = 1024 * 1024

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
        throw new ApiError(413, 'Side question body is too large', 'BODY_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { throw ApiError.badRequest('Invalid JSON body') }
}

export async function handleSideQuestionRoute(req: Request, url: URL, sessionId: string, questionId?: string): Promise<Response> {
  // Same persisted-session lookup as the surrounding session API. New empty
  // sessions cannot be prewarmed by /btw to accidentally begin a main turn.
  if (!conversationService.hasSession(sessionId)) {
    const summary = await sessionService.getSessionSummary(sessionId)
    if (!summary) throw ApiError.notFound(`Session not found: ${sessionId}`)
    if (summary.messageCount === 0) throw ApiError.conflict('Start a conversation before asking a side question')
  }
  if (req.method === 'POST' && questionId === undefined) {
    const parsed = sideQuestionInputSchema.safeParse(await readBody(req))
    if (!parsed.success) throw ApiError.badRequest('Invalid side question: questionId UUID, nonempty question, and at most 20 history pairs are required')
    return Response.json(await service.ask(sessionId, parsed.data, url, req.signal))
  }
  if (req.method === 'DELETE' && questionId !== undefined) {
    if (!z.uuid().safeParse(questionId).success) throw ApiError.badRequest('Invalid questionId')
    return Response.json({ questionId, cancelled: await service.cancel(sessionId, questionId) })
  }
  return Response.json({ error: 'METHOD_NOT_ALLOWED', message: 'Unsupported side question route' }, { status: 405 })
}
