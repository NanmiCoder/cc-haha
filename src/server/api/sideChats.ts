import { z } from 'zod/v4'
import { sessionService } from '../services/sessionService.js'
import { conversationService } from '../services/conversationService.js'
import { getSideChat, isSideChatId, registerSideChat, SIDE_CHAT_PREFIX, type SideChat } from '../services/sideChatRegistry.js'
import { ApiError } from '../middleware/errorHandler.js'

const inputSchema = z.strictObject({ sideChatId: z.uuid().optional() })
function response(entry: SideChat): Response {
  return Response.json({ sessionId: entry.sessionId, parentSessionId: entry.parentSessionId, workDir: entry.launchInfo.workDir, title: entry.launchInfo.customTitle, ephemeral: true })
}
export async function handleSideChatsRoute(req: Request, parentSessionId: string, childId?: string): Promise<Response> {
  if (isSideChatId(parentSessionId)) throw ApiError.badRequest('Nested side chats are not supported')
  if (req.method === 'DELETE' && childId) {
    const entry = getSideChat(childId)
    if (!entry || entry.parentSessionId !== parentSessionId) throw ApiError.notFound('Side chat not found')
    entry.closed = true
    await conversationService.stopSessionAndWait(childId)
    return Response.json({ sessionId: childId, closed: true })
  }
  if (req.method !== 'POST' || childId) return new Response(null, { status: 405 })
  const text = await req.text()
  if (text.length > 1024) throw ApiError.badRequest('Side chat request is too large')
  let input: unknown
  try { input = text ? JSON.parse(text) : {} } catch { throw ApiError.badRequest('Invalid JSON') }
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) throw ApiError.badRequest('Invalid side chat request')
  const cliSessionId = parsed.data.sideChatId ?? crypto.randomUUID()
  const sessionId = SIDE_CHAT_PREFIX + cliSessionId
  const existing = getSideChat(sessionId)
  if (existing) {
    if (existing.parentSessionId !== parentSessionId || existing.closed) throw ApiError.conflict('Side chat ID is already used')
    return response(existing)
  }
  const info = await sessionService.getSessionLaunchInfo(parentSessionId)
  if (!info) throw ApiError.notFound('Parent session not found')
  // Capture a stable transcript boundary. The CLI truncates at this UUID even
  // if the parent appends more messages before the child starts.
  const page = await sessionService.getSessionHistoryPage(parentSessionId, { limit: 100, projectContext: false })
  const last = page.messages.findLast(message => message.type !== 'system')
  if (!last) throw ApiError.conflict('Start a conversation before opening a side chat')
  const entry: SideChat = {
    sessionId, parentSessionId, cliSessionId, resumePath: info.filePath, resumeAt: last.id,
    launchInfo: { ...info, filePath: '', repository: undefined, worktreeSession: undefined, transcriptMessageCount: 0, customTitle: 'Side chat' },
    createdAt: new Date().toISOString(), started: false, closed: false,
  }
  const raced = getSideChat(sessionId)
  if (raced) {
    if (raced.parentSessionId !== parentSessionId || raced.closed) throw ApiError.conflict('Side chat ID is already used')
    return response(raced)
  }
  registerSideChat(entry)
  return response(entry)
}
