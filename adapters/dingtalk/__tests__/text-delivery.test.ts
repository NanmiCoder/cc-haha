import { afterEach, describe, expect, it } from 'bun:test'
import { sendDingTalkMarkdown } from '../text-delivery.js'
import { finishAndResetDingTalkStreamingState, flushDingTalkAiCard, type DingTalkStreamingState } from '../stream-state.js'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function stream() {
  const state: DingTalkStreamingState = {
    aiCardBuffers: new Map(), streamingCards: new Map(), streamingCardText: new Map(),
  }
  const delivery = {
    getOrCreateCard: () => null,
    sendText: (text: string, onChunkDelivered?: (remainingText: string) => void) =>
      sendDingTalkMarkdown('https://fixture.invalid/webhook', 'fixture-token', text, onChunkDelivered),
    aiCards: { stream: async () => {}, finish: async () => {} },
  }
  const flush = (text: string, complete: boolean) => flushDingTalkAiCard(state, 'chat', text, complete, delivery)
  state.finalize = () => flush('', true)
  return { state, flush }
}

describe('DingTalk terminal text delivery', () => {
  it.each(['http', 'business', 'malformed', 'missing acknowledgement'] as const)('retains the final answer after %s failure and delivers it on retry', async failure => {
    const { state, flush } = stream()
    const sent: string[] = []
    let failing = true
    globalThis.fetch = (async (_input, init) => {
      if (failing) return failure === 'http' ? new Response('unavailable', { status: 503 })
        : failure === 'business' ? Response.json({ errcode: 40014, errmsg: 'invalid token' })
          : failure === 'malformed' ? new Response('not json') : Response.json({})
      sent.push(JSON.parse(String(init?.body)).markdown.text)
      return Response.json({ errcode: 0 })
    }) as typeof fetch
    await flush('whole answer', false)
    await expect(finishAndResetDingTalkStreamingState(state, 'chat')).rejects.toThrow('DingTalk text delivery failed')
    expect(state.streamingCardText.get('chat')).toBe('whole answer')
    failing = false
    await finishAndResetDingTalkStreamingState(state, 'chat')
    await finishAndResetDingTalkStreamingState(state, 'chat')
    expect(sent).toEqual(['whole answer'])
    expect(state.streamingCardText.size).toBe(0)
  })

  it('recovers a transient failure automatically without another completion event', async () => {
    const { state, flush } = stream()
    let attempts = 0
    const sent: string[] = []
    globalThis.fetch = (async (_input, init) => {
      if (++attempts === 1) return new Response('offline', { status: 503 })
      sent.push(JSON.parse(String(init?.body)).markdown.text)
      return Response.json({ errcode: 0 })
    }) as typeof fetch
    await flush('recover without replay', false)
    await finishAndResetDingTalkStreamingState(state, 'chat')
    expect(attempts).toBe(2)
    expect(sent).toEqual(['recover without replay'])
    expect(state.streamingCardText.size).toBe(0)
  })

  it('retries only the unsent chunks after a later chunk fails', async () => {
    const { state, flush } = stream()
    const sent: string[] = []
    let failSecond = true
    globalThis.fetch = (async (_input, init) => {
      const text = JSON.parse(String(init?.body)).markdown.text as string
      if (text.startsWith('B') && failSecond) return Response.json({ errcode: 88 }, { status: 429 })
      sent.push(text)
      return Response.json({ errcode: 0 })
    }) as typeof fetch
    const first = 'A'.repeat(3500)
    const second = 'B'.repeat(3500)
    const third = 'C'.repeat(100)
    await flush(first + second + third, false)
    await expect(finishAndResetDingTalkStreamingState(state, 'chat')).rejects.toThrow()
    expect(sent).toEqual([first])
    expect(state.streamingCardText.get('chat')).not.toContain('A')
    failSecond = false
    await finishAndResetDingTalkStreamingState(state, 'chat')
    expect(sent).toEqual([first, second, third])
    expect(state.streamingCardText.size).toBe(0)
  })
})
