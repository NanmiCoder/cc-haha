import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { buildDeliverBody, DingTalkAiCardService } from '../ai-card.js'

describe('DingTalk AI Card streaming', () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string; body: any }> = []

  beforeEach(() => {
    calls.length = 0
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return new Response('{}', { status: 200 })
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('builds the official IM_ROBOT deliver payload', () => {
    expect(buildDeliverBody('card-1', { type: 'user', userId: 'staff-1' }, 'robot-1')).toMatchObject({
      outTrackId: 'card-1',
      openSpaceId: 'dtv1.card//IM_ROBOT.staff-1',
      imRobotOpenDeliverModel: {
        spaceType: 'IM_ROBOT',
        robotCode: 'robot-1',
      },
    })
  })

  it('creates, streams, and finishes an AI card', async () => {
    const service = new DingTalkAiCardService(async () => 'token-1', 'robot-1')
    const card = await service.createForTarget({ type: 'user', userId: 'staff-1' })

    expect(card?.cardInstanceId.startsWith('card_')).toBe(true)
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /v1.0/card/instances',
      'POST /v1.0/card/instances/deliver',
    ])

    await service.stream(card!, 'Hello', false)
    expect(calls.at(-2)?.body.cardData.cardParamMap.flowStatus).toBe('2')
    expect(new URL(calls.at(-1)!.url).pathname).toBe('/v1.0/card/streaming')
    expect(calls.at(-1)?.body).toMatchObject({
      key: 'msgContent',
      content: 'Hello',
      isFull: true,
      isFinalize: false,
    })

    calls.length = 0
    await service.finish(card!, 'Final')
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'PUT /v1.0/card/streaming',
      'PUT /v1.0/card/instances',
    ])
    expect(calls[0]!.body.isFinalize).toBe(true)
    expect(calls[1]!.body.cardData.cardParamMap.flowStatus).toBe('3')
  })

  it('times out a hung card streaming request', async () => {
    const previousTimeout = process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS
    process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS = '20'
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }) as any

    try {
      const service = new DingTalkAiCardService(async () => 'token-1', 'robot-1')
      const card = {
        cardInstanceId: 'card-hung',
        accessToken: 'token-1',
        tokenExpireTime: Date.now() + 60_000,
        inputingStarted: true,
      }

      await expect(service.stream(card, 'Hello', false)).rejects.toThrow(
        'PUT /v1.0/card/streaming timed out after 20ms',
      )
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS
      } else {
        process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS = previousTimeout
      }
    }
  })
})
