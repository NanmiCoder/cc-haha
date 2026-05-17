import { describe, expect, it } from 'bun:test'
import { MessageBuffer } from '../../common/message-buffer.js'
import { finishAndResetDingTalkStreamingState, resetDingTalkStreamingState } from '../stream-state.js'

describe('DingTalk streaming state', () => {
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
