import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { handleConversationsApi, getSessionChatState } from '../api/conversations.js'
import { sessionService } from '../services/sessionService.js'
import { conversationService } from '../services/conversationService.js'
import { __markActiveTurnForTests, __resetWebSocketHandlerStateForTests, getSessionChatActivityState } from '../ws/handler.js'

afterEach(() => {
  __resetWebSocketHandlerStateForTests()
  mock.restore()
})

describe('legacy REST conversation send', () => {
  for (const route of ['sessions', 'conversations']) {
    const request = async (sessionId: string, body: string) => {
      const pathname = route === 'sessions' ? `/api/sessions/${sessionId}/chat` : `/api/conversations/${sessionId}`
      const url = new URL(pathname, 'http://localhost')
      return handleConversationsApi(new Request(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }), url, pathname.split('/').filter(Boolean))
    }
    const existingSession = (sessionId: string) => spyOn(sessionService, 'getSessionSummary').mockResolvedValue(
      { sessionId } as NonNullable<Awaited<ReturnType<typeof sessionService.getSessionSummary>>>,
    )

    it(`${route}: rejects unsupported sending without pretending to queue or changing idle state`, async () => {
      const sessionId = crypto.randomUUID()
      existingSession(sessionId)
      const send = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
      const response = await request(sessionId, JSON.stringify({ content: 'Do not discard this silently' }))
      expect(response.status).toBe(501)
      const body = await response.json()
      expect(body.error).toBe('REST_CHAT_NOT_IMPLEMENTED')
      expect(body.message).toContain('WebSocket')
      expect(body).not.toHaveProperty('messageId')
      expect(body).not.toHaveProperty('status', 'queued')
      expect(getSessionChatState(sessionId)).toBe('idle')
      expect(getSessionChatActivityState(sessionId)).toBe('idle')
      expect(send).not.toHaveBeenCalled()
    })

    it(`${route}: does not disturb a real active turn`, async () => {
      const sessionId = crypto.randomUUID()
      existingSession(sessionId)
      __markActiveTurnForTests(sessionId)
      expect((await request(sessionId, '{"content":"follow-up"}')).status).toBe(501)
      expect(getSessionChatState(sessionId)).toBe('idle')
      expect(getSessionChatActivityState(sessionId)).toBe('running')
    })

    it(`${route}: preserves 404 for missing sessions and 400 for invalid bodies`, async () => {
      const sessionId = crypto.randomUUID()
      const summary = spyOn(sessionService, 'getSessionSummary').mockResolvedValue(null)
      expect((await request(sessionId, '{"content":"hello"}')).status).toBe(404)
      summary.mockRestore()
      existingSession(sessionId)
      for (const body of ['{', 'null', '[]', '{}', '{"content":42}', '{"content":""}']) {
        expect((await request(sessionId, body)).status).toBe(400)
      }
      expect(getSessionChatActivityState(sessionId)).toBe('idle')
    })
  }
})
