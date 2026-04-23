/**
 * cardkit.ts 单元测试
 *
 * 不调用真实的 Lark API —— 用 mock client 捕获调用参数，验证:
 * - 每个函数构造的 payload 结构
 * - 非零 code 响应抛出 CardKitApiError（可被 card-errors 识别）
 * - 缺失关键字段时抛错
 * - sequence 正确传递
 */

import { describe, it, expect } from 'bun:test'
import {
  createCardEntity,
  sendCardAsMessage,
  streamCardContent,
  setCardStreamingMode,
  updateCardKitCard,
  CardKitApiError,
  STREAMING_ELEMENT_ID,
} from '../cardkit.js'
import { isCardRateLimitError, isCardTableLimitError } from '../card-errors.js'

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

type MockCall = { api: string; args: any }

function makeMockClient(responses: Record<string, any>) {
  const calls: MockCall[] = []
  const recorder = (api: string, resp: any) => async (args: any) => {
    calls.push({ api, args })
    if (typeof resp === 'function') {
      return resp(args)
    }
    return resp
  }
  const client: any = {
    cardkit: {
      v1: {
        card: {
          create: recorder('cardkit.v1.card.create', responses['card.create']),
          settings: recorder('cardkit.v1.card.settings', responses['card.settings']),
          update: recorder('cardkit.v1.card.update', responses['card.update']),
        },
        cardElement: {
          content: recorder(
            'cardkit.v1.cardElement.content',
            responses['cardElement.content'],
          ),
        },
      },
    },
    im: {
      message: {
        create: recorder('im.message.create', responses['im.message.create']),
        reply: recorder('im.message.reply', responses['im.message.reply']),
      },
    },
  }
  return { client, calls }
}

// ---------------------------------------------------------------------------
// createCardEntity
// ---------------------------------------------------------------------------

describe('createCardEntity', () => {
  it('构造 card_json payload 并返回 card_id', async () => {
    const { client, calls } = makeMockClient({
      'card.create': {
        code: 0,
        data: { card_id: 'ck_abc_123' },
      },
    })
    const card = { schema: '2.0', body: { elements: [] } }
    const id = await createCardEntity(client, card)

    expect(id).toBe('ck_abc_123')
    expect(calls.length).toBe(1)
    expect(calls[0]!.api).toBe('cardkit.v1.card.create')
    expect(calls[0]!.args.data.type).toBe('card_json')
    // data.data 应当是 card 的 JSON 字符串
    expect(calls[0]!.args.data.data).toBe(JSON.stringify(card))
  })

  it('兼容顶层 card_id（某些 SDK 包装层）', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, card_id: 'top_level_id' },
    })
    const id = await createCardEntity(client, {})
    expect(id).toBe('top_level_id')
  })

  it('non-zero code 抛 CardKitApiError', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 230099, msg: 'something failed' },
    })
    await expect(createCardEntity(client, {})).rejects.toThrow(CardKitApiError)
  })

  it('code=0 但缺 card_id 抛错', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: {} },
    })
    await expect(createCardEntity(client, {})).rejects.toThrow(/missing card_id/)
  })
})

// ---------------------------------------------------------------------------
// sendCardAsMessage
// ---------------------------------------------------------------------------

describe('sendCardAsMessage', () => {
  it('无 replyTo: 走 im.message.create 使用 chat_id', async () => {
    const { client, calls } = makeMockClient({
      'im.message.create': { data: { message_id: 'om_new_msg_1' } },
    })
    const mid = await sendCardAsMessage(client, 'oc_chat_123', 'ck_id_xyz')
    expect(mid).toBe('om_new_msg_1')
    expect(calls.length).toBe(1)
    expect(calls[0]!.api).toBe('im.message.create')
    expect(calls[0]!.args.params.receive_id_type).toBe('chat_id')
    expect(calls[0]!.args.data.receive_id).toBe('oc_chat_123')
    expect(calls[0]!.args.data.msg_type).toBe('interactive')
    // content 格式: {"type":"card","data":{"card_id":"xxx"}}
    const parsed = JSON.parse(calls[0]!.args.data.content)
    expect(parsed).toEqual({ type: 'card', data: { card_id: 'ck_id_xyz' } })
  })

  it('有 replyTo: 走 im.message.reply', async () => {
    const { client, calls } = makeMockClient({
      'im.message.reply': { data: { message_id: 'om_reply_1' } },
    })
    const mid = await sendCardAsMessage(client, 'oc_chat_123', 'ck_id_xyz', 'om_parent')
    expect(mid).toBe('om_reply_1')
    expect(calls.length).toBe(1)
    expect(calls[0]!.api).toBe('im.message.reply')
    expect(calls[0]!.args.path.message_id).toBe('om_parent')
    const parsed = JSON.parse(calls[0]!.args.data.content)
    expect(parsed.data.card_id).toBe('ck_id_xyz')
  })

  it('缺 message_id 抛错', async () => {
    const { client } = makeMockClient({
      'im.message.create': { data: {} },
    })
    await expect(sendCardAsMessage(client, 'c', 'ck')).rejects.toThrow(
      /missing message_id/,
    )
  })
})

// ---------------------------------------------------------------------------
// streamCardContent
// ---------------------------------------------------------------------------

describe('streamCardContent', () => {
  it('构造 content + sequence payload，path 包含 card_id + element_id', async () => {
    const { client, calls } = makeMockClient({
      'cardElement.content': { code: 0 },
    })
    await streamCardContent(client, 'ck_abc', STREAMING_ELEMENT_ID, 'hello', 42)

    expect(calls.length).toBe(1)
    expect(calls[0]!.api).toBe('cardkit.v1.cardElement.content')
    expect(calls[0]!.args.data).toEqual({ content: 'hello', sequence: 42 })
    expect(calls[0]!.args.path).toEqual({
      card_id: 'ck_abc',
      element_id: STREAMING_ELEMENT_ID,
    })
  })

  it('STREAMING_ELEMENT_ID 常量 = "streaming_content"', () => {
    expect(STREAMING_ELEMENT_ID).toBe('streaming_content')
  })

  it('230020 响应可被 isCardRateLimitError 识别', async () => {
    const { client } = makeMockClient({
      'cardElement.content': { code: 230020, msg: 'rate limited' },
    })
    try {
      await streamCardContent(client, 'ck', 'el', 'x', 1)
      expect('should have thrown').toBe('but did not')
    } catch (err) {
      expect(err).toBeInstanceOf(CardKitApiError)
      expect(isCardRateLimitError(err)).toBe(true)
    }
  })

  it('230099 + table limit msg 可被 isCardTableLimitError 识别', async () => {
    const { client } = makeMockClient({
      'cardElement.content': {
        code: 230099,
        msg: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table; ',
      },
    })
    try {
      await streamCardContent(client, 'ck', 'el', 'x', 1)
      expect('should have thrown').toBe('but did not')
    } catch (err) {
      expect(err).toBeInstanceOf(CardKitApiError)
      expect(isCardTableLimitError(err)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// setCardStreamingMode
// ---------------------------------------------------------------------------

describe('setCardStreamingMode', () => {
  it('streaming_mode=false + sequence 正确传递', async () => {
    const { client, calls } = makeMockClient({
      'card.settings': { code: 0 },
    })
    await setCardStreamingMode(client, 'ck_xxx', false, 99)

    expect(calls.length).toBe(1)
    expect(calls[0]!.api).toBe('cardkit.v1.card.settings')
    expect(calls[0]!.args.path).toEqual({ card_id: 'ck_xxx' })
    expect(calls[0]!.args.data.sequence).toBe(99)
    // settings 是 JSON 字符串
    const settings = JSON.parse(calls[0]!.args.data.settings)
    expect(settings).toEqual({ streaming_mode: false })
  })

  it('streaming_mode=true 也能工作', async () => {
    const { client, calls } = makeMockClient({
      'card.settings': { code: 0 },
    })
    await setCardStreamingMode(client, 'ck', true, 1)
    const settings = JSON.parse(calls[0]!.args.data.settings)
    expect(settings).toEqual({ streaming_mode: true })
  })
})

// ---------------------------------------------------------------------------
// updateCardKitCard
// ---------------------------------------------------------------------------

describe('updateCardKitCard', () => {
  it('把 card 包装成 card_json payload + sequence', async () => {
    const { client, calls } = makeMockClient({
      'card.update': { code: 0 },
    })
    const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'done' }] } }
    await updateCardKitCard(client, 'ck_final', card, 100)

    expect(calls.length).toBe(1)
    expect(calls[0]!.api).toBe('cardkit.v1.card.update')
    expect(calls[0]!.args.path).toEqual({ card_id: 'ck_final' })
    expect(calls[0]!.args.data.sequence).toBe(100)
    expect(calls[0]!.args.data.card.type).toBe('card_json')
    expect(calls[0]!.args.data.card.data).toBe(JSON.stringify(card))
  })

  it('非零 code 抛 CardKitApiError', async () => {
    const { client } = makeMockClient({
      'card.update': { code: -1, msg: 'bad card' },
    })
    await expect(updateCardKitCard(client, 'ck', {}, 1)).rejects.toThrow(CardKitApiError)
  })
})

// ---------------------------------------------------------------------------
// CardKitApiError
// ---------------------------------------------------------------------------

describe('CardKitApiError', () => {
  it('携带 code 和 msg，可被 parseCardApiError 识别', () => {
    const err = new CardKitApiError({
      api: 'card.update',
      code: 230020,
      msg: 'rate limited',
      context: 'seq=5',
    })
    expect(err.code).toBe(230020)
    expect(err.msg).toBe('rate limited')
    expect(err.name).toBe('CardKitApiError')
    expect(isCardRateLimitError(err)).toBe(true)
  })

  it('消息包含 api 名和 context', () => {
    const err = new CardKitApiError({
      api: 'cardElement.content',
      code: 230099,
      msg: 'oops',
      context: 'seq=3 len=100',
    })
    expect(err.message).toContain('cardElement.content')
    expect(err.message).toContain('230099')
    expect(err.message).toContain('seq=3 len=100')
  })
})
