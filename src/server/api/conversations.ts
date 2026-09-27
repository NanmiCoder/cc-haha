/**
 * Conversation API Routes
 *
 * 提供对话交互的 REST 端点。实际的流式对话通过 WebSocket 处理，
 * 此处的 REST API 用于非流式操作与状态查询。
 *
 * Routes:
 *   POST /api/sessions/:id/chat        — 发送消息（入队）
 *   GET  /api/sessions/:id/chat/status  — 查询对话状态
 *   POST /api/sessions/:id/chat/stop    — 停止生成
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { sessionService } from '../services/sessionService.js'
import {
  clearLegacySessionChatState,
  getSessionChatActivityState,
  markSessionChatQueued,
} from '../ws/handler.js'

type LegacySessionChatState = 'idle' | 'thinking' | 'compacting' | 'tool_executing'

// Preserve the existing REST status contract for non-WebSocket callers.
const sessionStates = new Map<string, LegacySessionChatState>()

export async function handleConversationsApi(
  req: Request,
  url: URL,
  segments: string[]
): Promise<Response> {
  try {
    // segments: ['api', 'sessions', ':id', 'chat', ...rest]
    // or:       ['api', 'conversations', ...]
    //
    // When routed through the sessions handler:
    //   segments = ['api', 'sessions', sessionId, 'chat', subAction?]
    // When routed directly via /api/conversations:
    //   segments = ['api', 'conversations', sessionId, subAction?]

    let sessionId: string | undefined
    let subAction: string | undefined

    if (segments[1] === 'sessions') {
      // /api/sessions/:id/chat[/status|/stop]
      sessionId = segments[2]
      // segments[3] === 'chat'
      subAction = segments[4]
    } else {
      // /api/conversations/:id[/status|/stop]
      sessionId = segments[2]
      subAction = segments[3]
    }

    if (!sessionId) {
      throw ApiError.badRequest('Session ID is required')
    }

    // -----------------------------------------------------------------------
    // GET /chat/status
    // -----------------------------------------------------------------------
    if (subAction === 'status' && req.method === 'GET') {
      return getChatStatus(sessionId)
    }

    // -----------------------------------------------------------------------
    // POST /chat/stop
    // -----------------------------------------------------------------------
    if (subAction === 'stop' && req.method === 'POST') {
      return stopChat(sessionId)
    }

    // -----------------------------------------------------------------------
    // POST /chat (send message)
    // -----------------------------------------------------------------------
    if (!subAction) {
      if (req.method !== 'POST') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await sendMessage(req, sessionId)
    }

    return Response.json(
      { error: 'NOT_FOUND', message: `Unknown chat sub-resource: ${subAction}` },
      { status: 404 }
    )
  } catch (error) {
    return errorResponse(error)
  }
}

// ============================================================================
// Handler implementations
// ============================================================================

async function sendMessage(req: Request, sessionId: string): Promise<Response> {
  // Validate session exists. Materializing the full detail here would merge
  // every linked subagent transcript just to answer a boolean; the summary
  // reads list metadata instead (its own stream scan, but no subagent merge).
  // Same existence gate either way: both go through `findSessionFile`.
  const session = await sessionService.getSessionSummary(sessionId)
  if (!session) {
    throw ApiError.notFound(`Session not found: ${sessionId}`)
  }

  let body: { content?: string }
  try {
    body = (await req.json()) as { content?: string }
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  if (!body.content || typeof body.content !== 'string') {
    throw ApiError.badRequest('content (string) is required in request body')
  }

  const messageId = crypto.randomUUID()

  // This legacy REST endpoint only queues a response; real turn state is
  // tracked by the WebSocket handler once a client starts the turn.
  setSessionChatState(sessionId, 'thinking')

  return Response.json(
    { messageId, status: 'queued' as const },
    { status: 202 }
  )
}

function getChatStatus(sessionId: string): Response {
  const state = sessionStates.get(sessionId) || 'idle'
  const activityState = getSessionChatActivityState(sessionId)
  return Response.json({ state, activityState })
}

function stopChat(sessionId: string): Response {
  // Preserve the legacy endpoint's queue-reset behavior. Live generation is
  // interrupted by the WebSocket stop_generation command.
  setSessionChatState(sessionId, 'idle')
  return Response.json({ ok: true })
}

// ============================================================================
// Helpers for WebSocket integration (exported for use by ws/handler)
// ============================================================================

export function setSessionChatState(
  sessionId: string,
  state: LegacySessionChatState
): void {
  sessionStates.set(sessionId, state)
  if (state === 'idle') clearLegacySessionChatState(sessionId)
  else markSessionChatQueued(sessionId)
}

export function getSessionChatState(
  sessionId: string
): LegacySessionChatState {
  return sessionStates.get(sessionId) || 'idle'
}
