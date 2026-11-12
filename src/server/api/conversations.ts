/**
 * Conversation API Routes
 *
 * Provides REST endpoints for conversation interaction. Actual streaming conversations go through WebSocket;
 * this REST API is for non-streaming operations and status queries.
 *
 * Routes:
 *   POST /api/sessions/:id/chat        — not implemented; returns 501, use WebSocket to send
 *   GET  /api/sessions/:id/chat/status  — query conversation status
 *   POST /api/sessions/:id/chat/stop    — stop generation
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

  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  if (!body || typeof body !== 'object' || !('content' in body)
    || typeof body.content !== 'string' || !body.content) {
    throw ApiError.badRequest('content (string) is required in request body')
  }

  // No REST delivery queue exists. Do not acknowledge an unsubmitted message
  // or manufacture running activity; WebSocket owns actual turn admission.
  throw new ApiError(
    501,
    'REST chat message delivery is not implemented. Use the session WebSocket user_message command.',
    'REST_CHAT_NOT_IMPLEMENTED',
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
