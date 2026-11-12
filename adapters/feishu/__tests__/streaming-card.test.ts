/**
 * StreamingCard lifecycle tests
 *
 * Uses a mock Lark client to cover:
 * - ensureCreated: success path / fallback path
 * - appendText: accumulation + triggering throttled flush
 * - finalize: settings(false) + update ordering, monotonically increasing sequence
 * - abort: renders an error card
 * - 230020 → skip frame
 * - 230099 table limit → disable streaming, finalize still uses CardKit
 * - pure patch fallback path
 */

import { describe, it, expect } from 'bun:test'
import {
  StreamingCard,
  buildInitialStreamingCard,
  buildRenderedCard,
  buildErrorCard,
} from '../streaming-card.js'
import { STREAMING_ELEMENT_ID } from '../cardkit.js'

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

type ApiCall = { api: string; args: any }

type MockBehavior = {
  'card.create'?: any | ((args: any) => any)
  'card.settings'?: any | ((args: any) => any)
  'card.update'?: any | ((args: any) => any)
  'cardElement.content'?: any | ((args: any, callIdx: number) => any)
  'im.message.create'?: any | ((args: any) => any)
  'im.message.reply'?: any | ((args: any) => any)
  'im.message.patch'?: any | ((args: any, callIdx: number) => any)
}

function makeMockClient(behavior: MockBehavior = {}) {
  const calls: ApiCall[] = []
  let contentCallIdx = 0
  let patchCallIdx = 0

  function handle(api: string, resp: any, args: any, idx?: number): any {
    calls.push({ api, args })
    if (typeof resp === 'function') return resp(args, idx ?? 0)
    return resp
  }

  const client: any = {
    cardkit: {
      v1: {
        card: {
          create: async (args: any) =>
            handle('cardkit.v1.card.create', behavior['card.create'] ?? {
              code: 0, data: { card_id: 'ck_default' },
            }, args),
          settings: async (args: any) =>
            handle('cardkit.v1.card.settings', behavior['card.settings'] ?? { code: 0 }, args),
          update: async (args: any) =>
            handle('cardkit.v1.card.update', behavior['card.update'] ?? { code: 0 }, args),
        },
        cardElement: {
          content: async (args: any) => {
            const idx = contentCallIdx++
            return handle('cardkit.v1.cardElement.content',
              behavior['cardElement.content'] ?? { code: 0 }, args, idx)
          },
        },
      },
    },
    im: {
      message: {
        create: async (args: any) =>
          handle('im.message.create', behavior['im.message.create'] ?? {
            data: { message_id: 'om_default' },
          }, args),
        reply: async (args: any) =>
          handle('im.message.reply', behavior['im.message.reply'] ?? {
            data: { message_id: 'om_reply_default' },
          }, args),
        patch: async (args: any) => {
          const idx = patchCallIdx++
          return handle('im.message.patch', behavior['im.message.patch'] ?? { code: 0 }, args, idx)
        },
      },
    },
  }
  return { client, calls }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Card JSON builders
// ---------------------------------------------------------------------------

describe('buildInitialStreamingCard', () => {
  it('Schema 2.0 + streaming_mode + element_id', () => {
    const card = buildInitialStreamingCard() as any
    expect(card.schema).toBe('2.0')
    expect(card.config.streaming_mode).toBe(true)
    // Single element: streaming_content, initial content is the loading hint
    const elements = card.body.elements as any[]
    expect(elements.length).toBe(1)
    const streaming = elements[0]
    expect(streaming.tag).toBe('markdown')
    expect(streaming.content).toContain('Thinking...')
    expect(streaming.element_id).toBe(STREAMING_ELEMENT_ID)
  })
})

describe('buildRenderedCard', () => {
  it('Schema 2.0, no streaming_mode, single markdown element', () => {
    const card = buildRenderedCard('hello world') as any
    expect(card.schema).toBe('2.0')
    expect(card.config.streaming_mode).toBeUndefined()
    expect(card.body.elements.length).toBe(1)
    const el = card.body.elements[0]
    expect(el.tag).toBe('markdown')
    expect(el.content).toBe('hello world')
    // Final card needs no element_id
    expect(el.element_id).toBeUndefined()
  })

  it('empty string falls back to a single space', () => {
    const card = buildRenderedCard('') as any
    expect(card.body.elements[0].content).toBe(' ')
  })
})

describe('buildErrorCard', () => {
  it('red header + markdown body', () => {
    const card = buildErrorCard('oops') as any
    expect((card.header as any).template).toBe('red')
    expect((card.header as any).title.content).toContain('Something went wrong')
    expect(card.body.elements[0].content).toBe('oops')
  })
})

// ---------------------------------------------------------------------------
// StreamingCard lifecycle
// ---------------------------------------------------------------------------

describe('StreamingCard: ensureCreated (CardKit main path)', () => {
  it('concurrent callers wait until the same message has been created', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const { client, calls } = makeMockClient({
      'card.create': async () => {
        await pending
        return { code: 0, data: { card_id: 'ck_shared' } }
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'oc_chat_1' })
    const creating = sc.ensureCreated()
    const waiting = sc.ensureCreated().then(() => sc._getMessageId())
    release()
    const [, messageId] = await Promise.all([creating, waiting])
    expect(messageId).toBe('om_default')
    expect(calls.map((call) => call.api)).toEqual([
      'cardkit.v1.card.create', 'im.message.create',
    ])
    await sc.finalize()
  })

  it('calls card.create + im.message.create in order, sequence=1', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_main_1' } },
      'im.message.create': { data: { message_id: 'om_main_1' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'oc_chat_1' })
    await sc.ensureCreated()

    expect(sc._getPhase()).toBe('streaming')
    expect(sc._getCardId()).toBe('ck_main_1')
    expect(sc._getMessageId()).toBe('om_main_1')
    expect(sc._getSequence()).toBe(1)
    expect(sc._isCardKitStreamActive()).toBe(true)

    expect(calls[0]!.api).toBe('cardkit.v1.card.create')
    expect(calls[1]!.api).toBe('im.message.create')

    // Initial card JSON contains streaming_mode and element_id
    const cardJson = JSON.parse(calls[0]!.args.data.data)
    expect(cardJson.schema).toBe('2.0')
    expect(cardJson.config.streaming_mode).toBe(true)
    // The only element is streaming_content
    expect(cardJson.body.elements[0].element_id).toBe(STREAMING_ELEMENT_ID)

    // IM message references card_id
    const content = JSON.parse(calls[1]!.args.data.content)
    expect(content).toEqual({ type: 'card', data: { card_id: 'ck_main_1' } })
  })

  it('idempotent: repeated ensureCreated calls do not create again', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_1' } },
      'im.message.create': { data: { message_id: 'om_1' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    await sc.ensureCreated()
    await sc.ensureCreated()
    // Only one create + one send
    const createCalls = calls.filter((c) => c.api === 'cardkit.v1.card.create')
    const sendCalls = calls.filter((c) => c.api === 'im.message.create')
    expect(createCalls.length).toBe(1)
    expect(sendCalls.length).toBe(1)
  })

  it('replyToMessageId uses im.message.reply instead of create', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.reply': { data: { message_id: 'om_reply' } },
    })
    const sc = new StreamingCard({
      larkClient: client,
      chatId: 'c',
      replyToMessageId: 'om_parent',
    })
    await sc.ensureCreated()
    expect(calls.some((c) => c.api === 'im.message.reply')).toBe(true)
    expect(calls.some((c) => c.api === 'im.message.create')).toBe(false)
    expect(sc._getMessageId()).toBe('om_reply')
  })
})

describe('StreamingCard: ensureCreated (fallback path)', () => {
  it('CardKit create fails → send Schema 2.0 card directly + patch mode', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 99991672, msg: 'permission denied' },
      'im.message.create': { data: { message_id: 'om_fb' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    expect(sc._getPhase()).toBe('streaming')
    expect(sc._getCardId()).toBeNull()
    expect(sc._getMessageId()).toBe('om_fb')
    expect(sc._isCardKitStreamActive()).toBe(false)

    // The fallback sends a Schema 2.0 interactive card
    const createCall = calls.find((c) => c.api === 'im.message.create')
    expect(createCall).toBeDefined()
    expect(createCall!.args.data.msg_type).toBe('interactive')
    const cardContent = JSON.parse(createCall!.args.data.content)
    expect(cardContent.schema).toBe('2.0')
  })

  it('falls back when CardKit send fails (create succeeds but im.message.create fails)', async () => {
    let sendCallCount = 0
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': () => {
        sendCallCount++
        if (sendCallCount === 1) throw new Error('send failed')
        return { data: { message_id: 'om_fb2' } }
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    expect(sc._getPhase()).toBe('streaming')
    expect(sc._getCardId()).toBeNull()
    expect(sc._getMessageId()).toBe('om_fb2')
  })

  it('reuses the same uuid when falling back to create after a reply send failure, avoiding duplicate messages', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.reply': () => {
        throw Object.assign(new Error('reply failed after send'), { code: 231003 })
      },
      'im.message.create': { data: { message_id: 'om_fb_after_reply' } },
    })
    const sc = new StreamingCard({
      larkClient: client,
      chatId: 'c',
      replyToMessageId: 'om_parent',
    })

    await sc.ensureCreated()

    const replyCall = calls.find((c) => c.api === 'im.message.reply')
    const fallbackCreate = calls.find((c) => c.api === 'im.message.create')
    expect(replyCall).toBeDefined()
    expect(fallbackCreate).toBeDefined()
    expect(typeof replyCall!.args.data.uuid).toBe('string')
    expect(replyCall!.args.data.uuid.length).toBeGreaterThan(0)
    expect(fallbackCreate!.args.data.uuid).toBe(replyCall!.args.data.uuid)
  })

  it('fallback send also fails → aborted + throw', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 99991672 },
      'im.message.create': () => {
        throw new Error('really broken')
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await expect(sc.ensureCreated()).rejects.toThrow()
    expect(sc._getPhase()).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// appendText + flush
// ---------------------------------------------------------------------------

describe('StreamingCard: appendText + flush', () => {
  it('accumulated text is written to cardElement.content with monotonically increasing sequence', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_stream' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    // First appendText enters the throttle window (just ready, lastUpdateTime still fresh)
    sc.appendText('Hello ')
    sc.appendText('world')

    // Throttle window 100ms + margin
    await sleep(150)

    const contentCalls = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    expect(contentCalls.length).toBeGreaterThan(0)
    // The last flush should contain the full accumulated text
    const lastCall = contentCalls[contentCalls.length - 1]!
    expect(lastCall.args.data.content).toContain('Hello world')
    expect(lastCall.args.path.element_id).toBe(STREAMING_ELEMENT_ID)
    // sequence strictly monotonically increasing
    const seqs = contentCalls.map((c) => c.args.data.sequence)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!)
    }
  })

  it('does not flush again when content is unchanged (based on lastFlushedText)', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.appendText('same')
    await sleep(150)

    // Force another flush (no new text)
    await sc._getFlushController().flush()

    const contentCalls = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    // There should be only one content call
    expect(contentCalls.length).toBe(1)
  })

  it('appendText after completed is ignored', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    await sc.finalize()
    sc.appendText('ignored')
    expect(sc._getAccumulatedText()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

describe('StreamingCard: finalize', () => {
  it('settles as aborted when pending creation and its fallback both fail', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const { client, calls } = makeMockClient({
      'card.create': async () => {
        await pending
        throw new Error('create failed')
      },
      'im.message.create': () => { throw new Error('fallback failed') },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'oc_chat_1' })
    const creating = sc.ensureCreated().catch((err: Error) => err)
    sc.appendText('answer')
    const finalizing = sc.finalize()
    release()
    const [creationError] = await Promise.all([creating, finalizing])
    expect(creationError).toBeInstanceOf(Error)
    expect((creationError as Error).message).toBe('fallback failed')
    expect(sc._getPhase()).toBe('aborted')
    expect(calls.map((call) => call.api)).toEqual([
      'cardkit.v1.card.create', 'im.message.create',
    ])
  })

  for (const stage of ['card.create', 'im.message.create', 'fallback'] as const) {
    it(`waits for pending ${stage} before delivering the final answer`, async () => {
      let release!: () => void
      let entered!: () => void
      const pending = new Promise<void>((resolve) => { release = resolve })
      const started = new Promise<void>((resolve) => { entered = resolve })
      const delayed = async (response: any) => {
        entered()
        await pending
        return response
      }
      const { client, calls } = makeMockClient({
        'card.create': stage === 'fallback'
          ? { code: 999, msg: 'CardKit unavailable' }
          : stage === 'card.create'
            ? () => delayed({ code: 0, data: { card_id: 'ck_delayed' } })
            : undefined,
        'im.message.create': stage !== 'card.create'
          ? () => delayed({ data: { message_id: 'om_delayed' } })
          : undefined,
      })
      const sc = new StreamingCard({ larkClient: client, chatId: 'oc_chat_1' })
      const creating = sc.ensureCreated()
      await started
      sc.appendText('complete short answer')
      const finalizing = sc.finalize()
      release()
      await Promise.all([creating, finalizing])

      expect(sc._getPhase()).toBe('completed')
      const writes = calls.filter((call) => call.api === (
        stage === 'fallback' ? 'im.message.patch' : 'cardkit.v1.card.update'
      ))
      expect(writes).toHaveLength(1)
      const card = JSON.parse(stage === 'fallback'
        ? writes[0]!.args.data.content
        : writes[0]!.args.data.card.data)
      expect(card.body.elements[0].content).toBe('complete short answer')
      sc.appendText('ignored after completion')
      await sc._getFlushController().flush()
      expect(sc._getAccumulatedText()).toBe('complete short answer')
      expect(calls.filter((call) => call.api === 'cardkit.v1.cardElement.content')).toHaveLength(0)
    })
  }

  it('CardKit path: settings(false) + card.update, sequence increases continuously', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_final' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('# Title\n\nBody')
    await sleep(150)
    const contentSeqs = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .map((c) => c.args.data.sequence)
    const lastContentSeq = contentSeqs[contentSeqs.length - 1] ?? 1

    await sc.finalize()

    expect(sc._getPhase()).toBe('completed')

    const settingsCalls = calls.filter((c) => c.api === 'cardkit.v1.card.settings')
    const updateCalls = calls.filter((c) => c.api === 'cardkit.v1.card.update')
    expect(settingsCalls.length).toBe(1)
    expect(updateCalls.length).toBe(1)

    const settingsSeq = settingsCalls[0]!.args.data.sequence
    const updateSeq = updateCalls[0]!.args.data.sequence
    expect(settingsSeq).toBeGreaterThan(lastContentSeq)
    expect(updateSeq).toBeGreaterThan(settingsSeq)

    // settings turns off streaming_mode
    const settings = JSON.parse(settingsCalls[0]!.args.data.settings)
    expect(settings.streaming_mode).toBe(false)

    // update card content is the preprocessed markdown
    const finalCardJson = JSON.parse(updateCalls[0]!.args.data.card.data)
    const finalContent = finalCardJson.body.elements[0].content
    // H1 is downgraded to H4
    expect(finalContent).toContain('#### Title')
    expect(finalContent).toContain('Body')
  })

  it('Fallback path: im.message.patch sends the fully rendered card', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 99991672 },
      'im.message.create': { data: { message_id: 'om_fb' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('## Heading\n\nContent')
    await sleep(1600) // wait for the PATCH_MS window
    await sc.finalize()

    const patchCalls = calls.filter((c) => c.api === 'im.message.patch')
    expect(patchCalls.length).toBeGreaterThan(0)
    // The last patch is from finalize (full final card)
    const lastPatch = patchCalls[patchCalls.length - 1]!
    const finalCard = JSON.parse(lastPatch.args.data.content)
    const finalContent = finalCard.body.elements[0].content
    // ## → ##### downgrade
    expect(finalContent).toContain('##### Heading')
  })

  it('finalize when fully idle marks completed without throwing', async () => {
    const { client } = makeMockClient()
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.finalize()
    expect(sc._getPhase()).toBe('completed')
  })

  it('finalize keeps only answerText, discarding reasoning + toolSteps', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_term' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    // Push all three kinds of content
    sc.appendReasoning('Let me think about this problem carefully...')
    sc.startTool('tu_1', 'Read')
    sc.completeTool('tu_1', 'Read')
    sc.appendText('## Reply\n\nThis is the final reply body.')
    await sleep(150)

    // Intermediate streaming frames should include reasoning + tools + answer
    const lastMidFrame = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .pop()!.args.data.content as string
    expect(lastMidFrame).toContain('Thinking')
    expect(lastMidFrame).toContain('Read')
    expect(lastMidFrame).toContain('final reply body')

    await sc.finalize()

    // finalize uses card.update to replace the whole card with an answer-only version
    const updateCall = calls.filter((c) => c.api === 'cardkit.v1.card.update').pop()!
    const finalCardJson = JSON.parse(updateCall.args.data.card.data)
    const finalContent = finalCardJson.body.elements[0].content as string

    expect(finalContent).toContain('final reply body')
    // H2 → downgraded to H5
    expect(finalContent).toContain('##### Reply')
    // reasoning + tools should not appear in the final state
    expect(finalContent).not.toContain('Thinking')
    expect(finalContent).not.toContain('think about this problem')
    expect(finalContent).not.toContain('Read')
    expect(finalContent).not.toContain('🛠️')
    expect(finalContent).not.toContain('💭')
  })

  it('finalize edge case: without answerText falls back to combined rendering (keeps reasoning)', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_no_answer' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    // Only reasoning, no appendText —— an abnormal case that must degrade gracefully
    sc.appendReasoning('I was thinking but never produced an answer.')
    await sleep(150)

    await sc.finalize()
    const updateCall = calls.filter((c) => c.api === 'cardkit.v1.card.update').pop()!
    const finalContent = JSON.parse(updateCall.args.data.card.data).body.elements[0].content as string
    // At least the reasoning content is visible
    expect(finalContent).toContain('thinking')
  })

  it('finalize failure does not throw', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
      'card.settings': () => {
        throw new Error('settings exploded')
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('text')
    await sleep(150)
    // finalize catches errors internally and does not rethrow
    await sc.finalize()
    expect(sc._getPhase()).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Rate limit + table limit
// ---------------------------------------------------------------------------

describe('StreamingCard: error handling', () => {
  it('230020 rate limit → skip frame, later flushes continue', async () => {
    let callIdx = 0
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
      'cardElement.content': () => {
        const i = callIdx++
        if (i === 0) {
          const err: any = new Error('rate limit')
          err.code = 230020
          throw err
        }
        return { code: 0 }
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('first')
    await sleep(150)
    // First one is rate limited
    sc.appendText(' second')
    await sleep(150)
    // Second one should succeed

    // CardKit still active (no fallback)
    expect(sc._isCardKitStreamActive()).toBe(true)
    const contentCalls = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    expect(contentCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('230099 table limit → disable streaming but keep cardId; finalize still uses CardKit', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_tbl' } },
      'im.message.create': { data: { message_id: 'om' } },
      'cardElement.content': () => {
        const err: any = new Error('content failed')
        err.code = 230099
        err.msg = 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit; '
        throw err
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('some content')
    await sleep(150)
    expect(sc._isCardKitStreamActive()).toBe(false)
    expect(sc._getCardId()).toBe('ck_tbl') // card_id kept

    await sc.finalize()
    // finalize still uses CardKit settings + update (cardId still present)
    expect(calls.some((c) => c.api === 'cardkit.v1.card.settings')).toBe(true)
    expect(calls.some((c) => c.api === 'cardkit.v1.card.update')).toBe(true)
    // No patch
    expect(calls.some((c) => c.api === 'im.message.patch')).toBe(false)
  })

  it('a hung CardKit intermediate-frame request does not block message_complete finalization', async () => {
    const previousTimeout = process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS
    process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS = '20'
    try {
      const { client, calls } = makeMockClient({
        'card.create': { code: 0, data: { card_id: 'ck_hung' } },
        'im.message.create': { data: { message_id: 'om' } },
        'cardElement.content': () => new Promise(() => {}),
      })
      const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
      await sc.ensureCreated()

      sc.appendText('partial text')
      await sleep(60)

      const completed = await Promise.race([
        sc.finalize().then(() => true),
        sleep(250).then(() => false),
      ])

      expect(completed).toBe(true)
      expect(sc._getPhase()).toBe('completed')
      expect(calls.some((c) => c.api === 'cardkit.v1.card.settings')).toBe(true)
      expect(calls.some((c) => c.api === 'cardkit.v1.card.update')).toBe(true)
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS
      } else {
        process.env.CC_HAHA_IM_CARD_REQUEST_TIMEOUT_MS = previousTimeout
      }
    }
  })
})

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

describe('StreamingCard: abort', () => {
  it('waits for pending creation and renders the error without reopening streaming', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const { client, calls } = makeMockClient({
      'card.create': async () => {
        await pending
        return { code: 0, data: { card_id: 'ck_delayed' } }
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'oc_chat_1' })
    const creating = sc.ensureCreated()
    const aborting = sc.abort(new Error('session reset'))
    release()
    await Promise.all([creating, aborting])
    expect(sc._getPhase()).toBe('aborted')
    const updates = calls.filter((call) => call.api === 'cardkit.v1.card.update')
    expect(updates).toHaveLength(1)
    expect(JSON.parse(updates[0]!.args.data.card.data).body.elements[0].content).toBe('session reset')
    expect(calls.filter((call) => call.api === 'cardkit.v1.cardElement.content')).toHaveLength(0)
  })

  it('CardKit path: renders an error card and closes streaming', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_err' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    sc.appendText('partial...')
    await sleep(150)

    await sc.abort(new Error('something went wrong'))
    expect(sc._getPhase()).toBe('aborted')

    const updateCalls = calls.filter((c) => c.api === 'cardkit.v1.card.update')
    expect(updateCalls.length).toBeGreaterThan(0)
    const errCard = JSON.parse(updateCalls[updateCalls.length - 1]!.args.data.card.data)
    expect(errCard.header.template).toBe('red')
    expect(errCard.body.elements[0].content).toContain('something went wrong')
    // Keeps the partially accumulated text
    expect(errCard.body.elements[0].content).toContain('partial...')
  })

  it('abort during idle does not throw', async () => {
    const { client } = makeMockClient()
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.abort(new Error('before any card'))
    expect(sc._getPhase()).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// Reasoning / tool use rendering
// ---------------------------------------------------------------------------

describe('StreamingCard: appendReasoning', () => {
  it('accumulates thinking deltas and renders them in the card (plain markdown, no blockquote)', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_think' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.appendReasoning('Analyzing the problem. ')
    sc.appendReasoning('Let me check file A.')
    await sleep(150)

    const contentCalls = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    expect(contentCalls.length).toBeGreaterThan(0)
    const last = contentCalls[contentCalls.length - 1]!
    expect(last.args.data.content).toContain('💭')
    expect(last.args.data.content).toContain('Thinking')
    expect(last.args.data.content).toContain('Analyzing the problem.')
    expect(last.args.data.content).toContain('Let me check file A.')
    // No blockquote `>` prefix —— this is the key of the new format
    expect(last.args.data.content).not.toContain('> Analyzing')
    // No appendText → there should be no regular body text
    expect(sc._getAccumulatedReasoning()).toContain('Analyzing')
    expect(sc._getAccumulatedText()).toBe('')
  })

  it('appendReasoning after completed is ignored', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()
    await sc.finalize()
    sc.appendReasoning('too late')
    expect(sc._getAccumulatedReasoning()).toBe('')
  })
})

describe('StreamingCard: startTool / completeTool', () => {
  it('startTool pushes a running step, completeTool flips it to done', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_tool' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.startTool('tu_1', 'Read')
    await sleep(150)
    let steps = sc._getToolSteps()
    expect(steps.length).toBe(1)
    expect(steps[0]!.name).toBe('Read')
    expect(steps[0]!.status).toBe('running')

    // The card should also show "🛠️ ⚙️ Read" (inline form)
    const runningContent = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .map((c) => c.args.data.content)
      .join('\n')
    expect(runningContent).toContain('⚙️')
    expect(runningContent).toContain('Read')
    expect(runningContent).toContain('🛠️')

    sc.completeTool('tu_1', 'Read')
    await sleep(150)
    steps = sc._getToolSteps()
    expect(steps[0]!.status).toBe('done')

    // The latest flush should show "✅ Read" without "⚙️"
    const lastContent = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .pop()!.args.data.content as string
    expect(lastContent).toContain('✅')
    expect(lastContent).toContain('Read')
    // The whole line is replaced with `✅ Read`; the ⚙️ icon should no longer appear
    expect(lastContent).not.toContain('⚙️')
  })

  it('dedupes by toolUseId: the same id is not pushed twice', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.startTool('tu_1', 'Read')
    sc.startTool('tu_1', 'Read')
    sc.startTool('tu_1', 'Read')
    expect(sc._getToolSteps().length).toBe(1)
  })

  it('synthesizes an id from name + index when toolUseId is absent; different steps coexist', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.startTool(undefined, 'Read')
    sc.startTool(undefined, 'Read')
    // Different synthesized ids → two independent steps
    expect(sc._getToolSteps().length).toBe(2)
  })

  it('completeTool only matches the most recent running step with the same name', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.startTool('tu_1', 'Bash')
    sc.startTool('tu_2', 'Bash')
    sc.completeTool(undefined, 'Bash')
    const steps = sc._getToolSteps()
    // The later tu_2 is marked done
    expect(steps[0]!.status).toBe('running')
    expect(steps[1]!.status).toBe('done')
  })

  it('ignores empty toolName', async () => {
    const { client } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.startTool('tu_1', undefined)
    sc.startTool('tu_1', '')
    expect(sc._getToolSteps().length).toBe(0)
  })
})

// Reproduces the user's real scenario: user sends a message → server thinking → tool_use → final text.
// Verifies each stage writes its content to cardElement.content (not swallowed by throttle / phase
// gate / anything else).
describe('StreamingCard: real event stream (user scenario regression)', () => {
  it('thinking → tool_use → text should trigger a visible flush at every stage', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_real' } },
      'im.message.create': { data: { message_id: 'om_real' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'oc_real' })

    // 1. User sends a message → handleMessage pre-creates the card (fire-and-forget)
    const creating = sc.ensureCreated()
    await creating // wait for the card to be writable

    // 2. Server: status streaming + content_start{text} (thinking block)
    //    the content_start text branch in feishu/index.ts awaits ensureCreated again (no-op)
    // (no direct call here — equivalent to a no-op)

    // 3. Server: thinking deltas (5 increments, 30ms apart to simulate streaming)
    sc.appendReasoning('Analyzing the latest commits to find ')
    await sleep(30)
    sc.appendReasoning('breaking changes. Need to look at ')
    await sleep(30)
    sc.appendReasoning('the public API surface, the schema files, ')
    await sleep(30)
    sc.appendReasoning('and any removed exports. Let me check the ')
    await sleep(30)
    sc.appendReasoning('git log first.')

    // Wait for the throttle window to end
    await sleep(200)

    const flushesAfterReasoning = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content').length
    expect(flushesAfterReasoning).toBeGreaterThan(0)

    const lastReasoningContent = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .pop()!.args.data.content as string
    // Should contain the accumulated reasoning content
    expect(lastReasoningContent).toContain('breaking changes')
    expect(lastReasoningContent).toContain('git log first')

    // 4. Server: content_start{tool_use, name: 'Bash'}
    sc.startTool('tu_bash_1', 'Bash')
    await sleep(150)

    const lastWithTool = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .pop()!.args.data.content as string
    expect(lastWithTool).toContain('Bash')
    expect(lastWithTool).toContain('⚙️')
    expect(lastWithTool).toContain('🛠️')

    // 5. Server: tool_use_complete
    sc.completeTool('tu_bash_1', 'Bash')
    await sleep(150)

    const lastAfterToolDone = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .pop()!.args.data.content as string
    expect(lastAfterToolDone).toContain('Bash')
    // ⚙️ switches to ✅ —— the only step so far is done
    expect(lastAfterToolDone).toContain('✅')
    expect(lastAfterToolDone).not.toContain('⚙️')

    // 6. Second tool sequence
    sc.startTool('tu_read_1', 'Read')
    await sleep(150)
    sc.completeTool('tu_read_1', 'Read')
    await sleep(150)

    // 7. Final text output
    sc.appendText('## Breaking change analysis\n\n')
    await sleep(120)
    sc.appendText('1. **API rename**: foo → bar\n')
    await sleep(120)
    sc.appendText('2. **Removed export**: baz')
    await sleep(200)

    const lastWithText = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .pop()!.args.data.content as string
    // Should contain reasoning, tools and answer together
    expect(lastWithText).toContain('git log first') // reasoning
    expect(lastWithText).toContain('Bash') // tool
    expect(lastWithText).toContain('Read') // tool
    expect(lastWithText).toContain('Breaking change analysis') // answer (post optimize: H2→H5)
    expect(lastWithText).toContain('API rename')

    // 8. message_complete → finalize
    await sc.finalize()
    expect(sc._getPhase()).toBe('completed')

    // Verify settings + update finalization
    expect(calls.some((c) => c.api === 'cardkit.v1.card.settings')).toBe(true)
    expect(calls.some((c) => c.api === 'cardkit.v1.card.update')).toBe(true)
  })

  it('a first-frame failure during CardKit streaming should not permanently disable streaming —— later frames continue', async () => {
    let firstFrameRejected = false
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_recover' } },
      'im.message.create': { data: { message_id: 'om' } },
      'cardElement.content': () => {
        if (!firstFrameRejected) {
          firstFrameRejected = true
          // Simulate a *non*-rate-limit, *non*-table-limit error
          // A previous implementation set cardKitStreamActive to false; this test catches that problem
          const err: any = new Error('mystery cardkit error')
          err.code = 999999
          throw err
        }
        return { code: 0 }
      },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.appendReasoning('first thought')
    await sleep(150)
    // The first frame was rejected, but we expect streaming to stay on —— so the second frame can continue
    sc.appendReasoning(' second thought')
    await sleep(150)
    // Verify: at least 2 cardElement.content calls were attempted
    const contentCalls = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    expect(contentCalls.length).toBeGreaterThanOrEqual(2)
    // And streaming is still active
    expect(sc._isCardKitStreamActive()).toBe(true)
  })
})

describe('StreamingCard: combined rendering (tools + reasoning + text)', () => {
  it('three sections combine in order tools → reasoning → answer', async () => {
    const { client, calls } = makeMockClient({
      'card.create': { code: 0, data: { card_id: 'ck_all' } },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })
    await sc.ensureCreated()

    sc.appendReasoning('Should I read file A first?')
    sc.startTool('tu_1', 'Read')
    sc.appendText('Here is the answer.')
    await sleep(150)

    const lastContent = calls
      .filter((c) => c.api === 'cardkit.v1.cardElement.content')
      .pop()!.args.data.content as string

    const idxTools = lastContent.indexOf('🛠️')
    const idxReasoning = lastContent.indexOf('Thinking')
    const idxAnswer = lastContent.indexOf('Here is the answer')

    expect(idxTools).toBeGreaterThan(-1)
    expect(idxReasoning).toBeGreaterThan(-1)
    expect(idxAnswer).toBeGreaterThan(-1)
    // tools at the very top → reasoning in the middle → answer at the bottom
    expect(idxTools).toBeLessThan(idxReasoning)
    expect(idxReasoning).toBeLessThan(idxAnswer)
  })

  it('a tool_use arriving during ensureCreated is flushed as soon as the card is writable', async () => {
    let resolveCreate: (() => void) | null = null
    const createLatch = new Promise<void>((r) => { resolveCreate = r })

    const { client, calls } = makeMockClient({
      'card.create': async () => {
        await createLatch
        return { code: 0, data: { card_id: 'ck_slow' } }
      },
      'im.message.create': { data: { message_id: 'om' } },
    })
    const sc = new StreamingCard({ larkClient: client, chatId: 'c' })

    // Don't await: push a tool step before create resolves
    const creating = sc.ensureCreated()
    // Let the event loop advance until create is awaited
    await sleep(10)
    sc.startTool('tu_1', 'Glob')

    // cardMessageReady is still false here —— no flush at all
    const contentBefore = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    expect(contentBefore.length).toBe(0)

    // Unlock create → ensureCreated continues → setCardMessageReady(true) → triggers pending flush
    resolveCreate!()
    await creating
    await sleep(150)

    const contentAfter = calls.filter((c) => c.api === 'cardkit.v1.cardElement.content')
    expect(contentAfter.length).toBeGreaterThan(0)
    const last = contentAfter[contentAfter.length - 1]!
    expect(last.args.data.content).toContain('Glob')
    expect(last.args.data.content).toContain('🛠️')
  })
})
