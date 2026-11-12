/**
 * cardkit.ts unit tests
 *
 * Does not call the real Lark API —— uses a mock client to capture call arguments and verify:
 * - the payload structure built by each function
 * - non-zero code responses throw CardKitApiError (recognizable by card-errors)
 * - errors are thrown when key fields are missing
 * - sequence is passed correctly
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
  it('builds card_json payload and returns card_id', async () => {
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
    // data.data should be the card's JSON string
    expect(calls[0]!.args.data.data).toBe(JSON.stringify(card))
  })

  it('handles top-level card_id (some SDK wrapper layers)', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, card_id: 'top_level_id' },
    })
    const id = await createCardEntity(client, {})
    expect(id).toBe('top_level_id')
  })

  it('non-zero code throws CardKitApiError', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 230099, msg: 'something failed' },
    })
    await expect(createCardEntity(client, {})).rejects.toThrow(CardKitApiError)
  })

  it('throws when code=0 but card_id is missing', async () => {
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
  it('no replyTo: uses im.message.create with chat_id', async () => {
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
    // content format: {"type":"card","data":{"card_id":"xxx"}}
    const parsed = JSON.parse(calls[0]!.args.data.content)
    expect(parsed).toEqual({ type: 'card', data: { card_id: 'ck_id_xyz' } })
  })

  it('with replyTo: uses im.message.reply', async () => {
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

  it('throws when message_id is missing', async () => {
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
  it('builds content + sequence payload; path contains card_id + element_id', async () => {
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

  it('STREAMING_ELEMENT_ID constant = "streaming_content"', () => {
    expect(STREAMING_ELEMENT_ID).toBe('streaming_content')
  })

  it('230020 response is recognized by isCardRateLimitError', async () => {
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

  it('230099 + table limit msg is recognized by isCardTableLimitError', async () => {
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
  it('streaming_mode=false + sequence passed correctly', async () => {
    const { client, calls } = makeMockClient({
      'card.settings': { code: 0 },
    })
    await setCardStreamingMode(client, 'ck_xxx', false, 99)

    expect(calls.length).toBe(1)
    expect(calls[0]!.api).toBe('cardkit.v1.card.settings')
    expect(calls[0]!.args.path).toEqual({ card_id: 'ck_xxx' })
    expect(calls[0]!.args.data.sequence).toBe(99)
    // settings is a JSON string
    const settings = JSON.parse(calls[0]!.args.data.settings)
    expect(settings).toEqual({ streaming_mode: false })
  })

  it('streaming_mode=true also works', async () => {
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
  it('wraps card into card_json payload + sequence', async () => {
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

  it('non-zero code throws CardKitApiError', async () => {
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
  it('carries code and msg, recognizable by parseCardApiError', () => {
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

  it('message includes api name and context', () => {
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
