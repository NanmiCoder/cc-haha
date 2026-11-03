import { describe, expect, it } from 'bun:test'
import { MessageBuffer } from '../../common/message-buffer.js'
import { finishAndResetDingTalkStreamingState, flushDingTalkAiCard, resetDingTalkStreamingState, type DingTalkStreamingState } from '../stream-state.js'
import type { DingTalkAiCardInstance } from '../ai-card.js'

describe('DingTalk streaming state', () => {
  for (const failure of ['create', 'finish', 'missing target'] as const) {
    for (const bufferedTail of [true, false]) {
      it(`sends final markdown once after ${failure} failure with ${bufferedTail ? 'buffered' : 'already flushed'} output`, async () => {
        const sent: string[] = []
        const card: DingTalkAiCardInstance = {
          cardInstanceId: 'test-card',
          accessToken: 'test-token',
          tokenExpireTime: 0,
          inputingStarted: false,
        }
        const state: DingTalkStreamingState = {
          aiCardBuffers: new Map(),
          streamingCards: new Map(),
          streamingCardText: new Map(),
        }
        const delivery = {
          getOrCreateCard: () => {
            if (failure === 'missing target') return null
            let pending = state.streamingCards.get('chat-1')
            if (!pending) {
              pending = Promise.resolve(failure === 'create' ? null : card)
              state.streamingCards.set('chat-1', pending)
            }
            return pending
          },
          sendText: async (text: string) => { sent.push(text) },
          aiCards: {
            stream: async () => {},
            finish: async () => { throw new Error('finish failed') },
          },
        }
        const flush = (text: string, complete: boolean) =>
          flushDingTalkAiCard(state, 'chat-1', text, complete, delivery)
        const buffer = new MessageBuffer(flush, 60_000, 1000)
        state.aiCardBuffers.set('chat-1', buffer)
        state.finalize = () => flush('', true)

        await flush('full ', false)
        if (bufferedTail) buffer.append('answer')
        else await flush('answer', false)

        await finishAndResetDingTalkStreamingState(state, 'chat-1')

        expect(sent).toEqual(['full answer'])
        expect(state.aiCardBuffers.size).toBe(0)
        expect(state.streamingCards.size).toBe(0)
        expect(state.streamingCardText.size).toBe(0)
      })
    }
  }

  it('drops the active AI card stream when permission interrupts output ordering', async () => {
    let resetCalled = false
    const buffer = new MessageBuffer(async () => {}, 100, 1000)
    const originalReset = buffer.reset.bind(buffer)
    buffer.reset = () => {
      resetCalled = true
      originalReset()
    }

    const state = {
      aiCardBuffers: new Map([['chat-1', buffer]]),
      streamingCards: new Map([['chat-1', Promise.resolve(null)]]),
      streamingCardText: new Map([['chat-1', 'pre-permission text']]),
    }

    resetDingTalkStreamingState(state, 'chat-1')

    expect(resetCalled).toBe(true)
    expect(state.aiCardBuffers.has('chat-1')).toBe(false)
    expect(state.streamingCards.has('chat-1')).toBe(false)
    expect(state.streamingCardText.has('chat-1')).toBe(false)
  })

  it('completes the existing stream before dropping it for a permission request', async () => {
    const flushed: Array<{ text: string; complete: boolean }> = []
    let finalized = false
    const buffer = new MessageBuffer(
      async (text, complete) => {
        flushed.push({ text, complete })
      },
      100,
      1000,
    )
    buffer.append('pre-permission text')

    const state = {
      aiCardBuffers: new Map([['chat-1', buffer]]),
      streamingCards: new Map([['chat-1', Promise.resolve(null)]]),
      streamingCardText: new Map([['chat-1', 'already streamed']]),
      finalize: async () => {
        finalized = true
      },
    }

    await finishAndResetDingTalkStreamingState(state, 'chat-1')

    expect(flushed).toEqual([{ text: 'pre-permission text', complete: true }])
    expect(finalized).toBe(true)
    expect(state.aiCardBuffers.has('chat-1')).toBe(false)
    expect(state.streamingCards.has('chat-1')).toBe(false)
    expect(state.streamingCardText.has('chat-1')).toBe(false)
  })

  it('finalizes an already-flushed card even when the message buffer is empty', async () => {
    let finalized = false
    const buffer = new MessageBuffer(async () => {}, 100, 1000)
    const state = {
      aiCardBuffers: new Map([['chat-1', buffer]]),
      streamingCards: new Map([['chat-1', Promise.resolve(null)]]),
      streamingCardText: new Map([['chat-1', 'already streamed']]),
      finalize: async () => {
        finalized = true
      },
    }

    await finishAndResetDingTalkStreamingState(state, 'chat-1')

    expect(finalized).toBe(true)
    expect(state.aiCardBuffers.has('chat-1')).toBe(false)
    expect(state.streamingCards.has('chat-1')).toBe(false)
    expect(state.streamingCardText.has('chat-1')).toBe(false)
  })
})
