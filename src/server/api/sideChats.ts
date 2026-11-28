import { z } from 'zod/v4'
import { sessionService } from '../services/sessionService.js'
import { conversationService } from '../services/conversationService.js'
import { getSideChat, isSideChatId, registerSideChat, SIDE_CHAT_PREFIX, type SideChat } from '../services/sideChatRegistry.js'
import { ANTIGRAVITY_DEFAULT_MODEL, ANTIGRAVITY_PROVIDER_ID } from '../services/antigravityAcp.js'
import { extractAntigravitySideChatSnapshot } from '../services/antigravityForkContext.js'
import { ApiError } from '../middleware/errorHandler.js'
import { loadMessagesFromJsonlPath } from '../../utils/conversationRecovery.js'

const inputSchema = z.strictObject({ sideChatId: z.uuid().optional() })
function response(entry: SideChat): Response {
  const { workDir, customTitle, permissionMode, runtimeProviderId, runtimeModelId, effortLevel } = entry.launchInfo
  return Response.json({
    sessionId: entry.sessionId,
    parentSessionId: entry.parentSessionId,
    workDir,
    title: customTitle,
    ephemeral: true,
    ...(permissionMode ? { permissionMode } : {}),
    ...(runtimeProviderId !== undefined ? { runtimeProviderId } : {}),
    ...(runtimeModelId ? { runtimeModelId } : {}),
    ...(effortLevel ? { effortLevel } : {}),
  })
}
export async function handleSideChatsRoute(req: Request, parentSessionId: string, childId?: string): Promise<Response> {
  if (isSideChatId(parentSessionId)) throw ApiError.badRequest('Nested side chats are not supported')
  if (req.method === 'DELETE' && childId) {
    const entry = getSideChat(childId)
    if (!entry || entry.parentSessionId !== parentSessionId) throw ApiError.notFound('Side chat not found')
    entry.closed = true
    entry.antigravitySeedContext = undefined
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
  if (info?.agentProfile === 'lean') throw ApiError.conflict('Side chats are unavailable in lean sessions')
  if (!info) throw ApiError.notFound('Parent session not found')

  const liveParentRuntime = conversationService.getSessionRuntimeSelection(parentSessionId)
  const isAntigravityParent =
    info.runtimeProviderId === ANTIGRAVITY_PROVIDER_ID ||
    liveParentRuntime?.providerId === ANTIGRAVITY_PROVIDER_ID

  let resumeAt: string
  let antigravitySeedContext: string | undefined
  if (isAntigravityParent) {
    if (!sessionService.shouldPersistSession()) {
      throw new ApiError(
        409,
        'Antigravity CLI keeps its own history and is unavailable when session history is disabled.',
        'ANTIGRAVITY_UNSUPPORTED',
      )
    }
    // Capture an immutable context snapshot at the current parent transcript boundary
    // so subsequent parent turns cannot leak into this side chat.
    const snapshot = await extractAntigravitySideChatSnapshot(info.filePath)
    if (!snapshot) throw ApiError.conflict('Start a conversation before opening a side chat')
    resumeAt = snapshot.resumeAt
    antigravitySeedContext = snapshot.seedContext
  } else {
    // Capture a stable transcript boundary. The CLI truncates at this UUID even
    // if the parent appends more messages before the child starts.
    const { messages } = await loadMessagesFromJsonlPath(info.filePath)
    const last = messages.findLast(message => message.type !== 'system')
    if (!last) throw ApiError.conflict('Start a conversation before opening a side chat')
    resumeAt = last.uuid
  }

  const livePermissionMode = conversationService.hasSession(parentSessionId)
    ? conversationService.getSessionPermissionMode(parentSessionId)
    : undefined

  const entry: SideChat = {
    sessionId,
    parentSessionId,
    cliSessionId,
    resumePath: info.filePath,
    resumeAt,
    ...(antigravitySeedContext ? { antigravitySeedContext } : {}),
    launchInfo: {
      ...info,
      filePath: '',
      nativeSessionId: undefined,
      antigravityForkSeedPending: undefined,
      repository: undefined,
      worktreeSession: undefined,
      transcriptMessageCount: 0,
      customTitle: 'Side chat',
      ...(livePermissionMode ? { permissionMode: livePermissionMode } : {}),
      ...(isAntigravityParent
        ? {
            runtimeProviderId: ANTIGRAVITY_PROVIDER_ID,
            runtimeModelId: liveParentRuntime?.modelId ?? info.runtimeModelId ?? ANTIGRAVITY_DEFAULT_MODEL,
            effortLevel: liveParentRuntime ? liveParentRuntime.effortLevel : info.effortLevel,
          }
        : {}),
    },
    createdAt: new Date().toISOString(),
    started: false,
    closed: false,
  }
  const raced = getSideChat(sessionId)
  if (raced) {
    if (raced.parentSessionId !== parentSessionId || raced.closed) throw ApiError.conflict('Side chat ID is already used')
    return response(raced)
  }
  registerSideChat(entry)
  return response(entry)
}
