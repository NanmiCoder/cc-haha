import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeMemberTranscriptDelta, mergeMemberTranscriptMessages, useTeamStore } from './teamStore'
import { useChatStore } from './chatStore'
import type { UIMessage } from '../types/chat'

const { transcript, send } = vi.hoisted(() => ({ transcript: vi.fn(), send: vi.fn() }))
vi.mock('../api/teams', () => ({
  teamsApi: { getMemberTranscript: transcript, sendMemberMessage: send },
}))

const sentAt = Date.parse('2026-10-26T00:00:00Z')
const sessionId = 'team-member:worker@repro'
const prompt = (id: string, timestamp: number, pending = false, teammateFrom?: string): UIMessage => ({
  id, type: 'user_text', content: 'review selector', timestamp, pending, teammateFrom,
})
const answer: UIMessage = {
  id: 'answer', type: 'assistant_text', content: 'reviewed', timestamp: sentAt + 310_000,
}

describe('team member mailbox steer replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(sentAt)
    transcript.mockReset()
    send.mockReset()
    send.mockResolvedValue({ ok: true })
    useTeamStore.getState().clearTeam()
    useChatStore.setState({ sessions: {} })
  })

  afterEach(() => {
    useTeamStore.getState().stopMemberPolling()
    useTeamStore.getState().clearTeam()
    vi.useRealTimers()
  })

  for (const [name, merge] of [
    ['delta', mergeMemberTranscriptDelta],
    ['full', mergeMemberTranscriptMessages],
  ] as const) {
    describe(name, () => {
      for (const delay of [1000, 300_000]) {
        it(`consumes a mailbox user echo after ${delay}ms`, () => {
          const result = merge(
            [prompt('pending', sentAt, true)],
            [prompt('echo', sentAt + delay, false, 'user'), answer],
          )
          expect(result.map(message => message.id)).toEqual(['echo', 'answer'])
        })
      }

      it('does not reuse one echo across polls for two identical queued sends', () => {
        const echo = prompt('echo', sentAt + 300_000, false, 'user')
        const pending = [
          prompt('pending-1', sentAt, true),
          prompt('pending-2', sentAt + 1, true),
        ]
        const firstPoll = merge(pending, [echo])
        expect(firstPoll.map(message => message.id)).toEqual(['echo', 'pending-2'])
        const secondPoll = merge(firstPoll, [echo])
        expect(secondPoll.map(message => message.id)).toEqual(['echo', 'pending-2'])
        const secondEcho = prompt('echo-2', sentAt + 310_000, false, 'user')
        expect(merge(secondPoll, [echo, secondEcho]).map(message => message.id))
          .toEqual(['echo', 'echo-2'])
      })

      it('preserves a new repeated send when replay contains an already seen old echo', () => {
        const oldEcho = prompt('old-echo', sentAt, false, 'user')
        const pending = prompt('new-pending', sentAt + 3000, true)
        expect(merge([oldEcho, pending], [oldEcho]).map(message => message.id))
          .toEqual(['old-echo', 'new-pending'])
      })

      it('does not consume a send using an unseen mailbox echo that predates it', () => {
        const oldEcho = prompt('old-echo', sentAt - 1, false, 'user')
        expect(merge([prompt('pending', sentAt, true)], [oldEcho]).map(message => message.id))
          .toEqual(['old-echo', 'pending'])
      })
    })
  }

  for (const batch of ['two-users', 'user-peer', 'peer-user'] as const) {
    for (const asBlocks of [false, true]) {
      it(`settles and reconciles a ${batch} mailbox batch (blocks=${asBlocks})`, async () => {
        useTeamStore.setState({
          activeTeam: {
            name: 'repro',
            members: [{
              agentId: 'worker@repro', name: 'worker', role: 'worker',
              status: 'idle', activity: 'idle',
            }],
          },
        })
        transcript.mockResolvedValue({ messages: [] })
        await useTeamStore.getState().refreshMemberSession(sessionId)
        useChatStore.getState().sendMessage(sessionId, 'review selector')
        if (batch === 'two-users') {
          useChatStore.getState().sendMessage(sessionId, 'review selector')
        }
        await useTeamStore.getState().refreshMemberSession(sessionId)
        useTeamStore.getState().stopMemberPolling()
        const user = '<teammate-message teammate_id="user">review selector</teammate-message>'
        const peer = '<teammate-message teammate_id="peer">review selector</teammate-message>'
        const envelopes = batch === 'two-users' ? [user, user]
          : batch === 'user-peer' ? [user, peer] : [peer, user]
        transcript.mockResolvedValue({ messages: [
          {
            id: 'batch', type: 'user',
            content: asBlocks
              ? envelopes.map(text => ({ type: 'text', text }))
              : envelopes.join('\n\n'),
            timestamp: new Date(sentAt + 300_000).toISOString(),
          },
          {
            id: 'answer', type: 'assistant', content: [{ type: 'text', text: 'reviewed' }],
            timestamp: new Date(sentAt + 301_000).toISOString(),
          },
        ] })
        await useTeamStore.getState().refreshMemberSession(sessionId)
        expect(useChatStore.getState().sessions[sessionId]?.messages.filter(
          message => message.type === 'user_text' && message.pending,
        )).toEqual([])
        expect(useChatStore.getState().sessions[sessionId]?.chatState).toBe('idle')

        // Replaying the batch cannot acknowledge another identical send.
        useChatStore.getState().sendMessage(sessionId, 'review selector')
        await useTeamStore.getState().refreshMemberSession(sessionId)
        expect(useChatStore.getState().sessions[sessionId]?.messages.filter(
          message => message.type === 'user_text' && message.pending,
        )).toHaveLength(1)
        expect(useChatStore.getState().sessions[sessionId]?.chatState).toBe('thinking')
      })
    }
  }

  for (const delay of [1000, 300_000]) {
    it(`settles the real store after a mailbox echo and completed answer after ${delay}ms`, async () => {
      const member = {
        agentId: 'worker@repro', name: 'worker', role: 'worker',
        status: 'idle' as const, activity: 'idle' as const,
      }
      useTeamStore.setState({ activeTeam: { name: 'repro', members: [member] } })
      transcript.mockResolvedValue({ messages: [] })
      await useTeamStore.getState().refreshMemberSession(sessionId)
      useChatStore.setState(state => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId]!,
            messages: [prompt('pending', sentAt, true)],
          },
        },
      }))
      await useTeamStore.getState().sendMessageToMember(sessionId, 'review selector')
      useTeamStore.getState().stopMemberPolling()
      expect(useChatStore.getState().sessions[sessionId]?.chatState).toBe('thinking')
      transcript.mockResolvedValue({ messages: [
        {
          id: 'echo', type: 'user',
          content: '<teammate-message teammate_id="user">\nreview selector\n</teammate-message>',
          timestamp: new Date(sentAt + delay).toISOString(),
        },
        {
          id: 'answer', type: 'assistant', content: [{ type: 'text', text: 'reviewed' }],
          timestamp: new Date(sentAt + delay + 1000).toISOString(),
        },
      ] })
      await useTeamStore.getState().refreshMemberSession(sessionId)
      const session = useChatStore.getState().sessions[sessionId]
      expect(session?.messages).toEqual([
        expect.objectContaining({ teammateFrom: 'user', content: 'review selector' }),
        expect.objectContaining({ type: 'assistant_text', content: 'reviewed' }),
      ])
      expect(session?.chatState).toBe('idle')
      await useTeamStore.getState().refreshMemberSession(sessionId)
      expect(useChatStore.getState().sessions[sessionId]?.messages).toEqual(session?.messages)
      expect(useChatStore.getState().sessions[sessionId]?.chatState).toBe('idle')
    })
  }
})
