import { describe, expect, it } from 'bun:test'
import { TelegramStreamDelivery, type TelegramDeliveryApi } from '../stream-delivery.js'

type Failure = unknown | null

function createFakeApi(options: {
  editFailures?: Failure[]
  sendFailure?: (text: string, attempt: number) => Failure
} = {}) {
  let nextMessageId = 1
  let nonPlaceholderSendAttempts = 0
  const messages = new Map<number, string>()
  const editAttempts: string[] = []
  const sendAttempts: string[] = []
  const editFailures = [...(options.editFailures ?? [])]

  const api: TelegramDeliveryApi = {
    async sendMessage(_chatId, text) {
      sendAttempts.push(text)
      if (text !== '▍') {
        nonPlaceholderSendAttempts += 1
        const failure = options.sendFailure?.(text, nonPlaceholderSendAttempts)
        if (failure) throw failure
      }
      const messageId = nextMessageId++
      messages.set(messageId, text)
      return { message_id: messageId }
    },
    async editMessageText(_chatId, messageId, text) {
      editAttempts.push(text)
      const failure = editFailures.shift()
      if (failure) throw failure
      messages.set(messageId, text)
      return {}
    },
  }

  return { api, messages, editAttempts, sendAttempts }
}

function createDelivery(
  api: TelegramDeliveryApi,
  options: {
    bufferCharThreshold?: number
    delays?: number[]
    warnings?: string[]
  } = {},
) {
  return new TelegramStreamDelivery(api, {
    bufferIntervalMs: 60_000,
    bufferCharThreshold: options.bufferCharThreshold ?? 20_000,
    sleep: async (ms) => { options.delays?.push(ms) },
    warn: (message) => { options.warnings?.push(message) },
  })
}

async function streamReply(
  delivery: TelegramStreamDelivery,
  chatId: string,
  deltas: string[],
): Promise<void> {
  await delivery.handleEvent(chatId, { type: 'content_start', blockType: 'text' })
  for (const text of deltas) {
    await delivery.handleEvent(chatId, { type: 'content_delta', text })
  }
  await delivery.handleEvent(chatId, { type: 'message_complete' })
}

describe('TelegramStreamDelivery', () => {
  it('delivers the complete reply through the real stream transition', async () => {
    const fake = createFakeApi()
    const delivery = createDelivery(fake.api)
    const answer = '第一句完整。第二句也完整。第三句收尾。'

    await streamReply(delivery, '42', ['第一句完整。', '第二句也完整。', '第三句收尾。'])

    expect([...fake.messages.values()]).toEqual([answer])
    expect(delivery.hasState('42')).toBe(false)
  })

  it('preserves failed streaming deltas and falls back to a complete send when final edits fail', async () => {
    const rateLimit = { error_code: 429, parameters: { retry_after: 1 } }
    const fake = createFakeApi({
      editFailures: [null, rateLimit, rateLimit, rateLimit, rateLimit],
    })
    const delays: number[] = []
    const warnings: string[] = []
    const delivery = createDelivery(fake.api, {
      bufferCharThreshold: 1,
      delays,
      warnings,
    })
    const answer = '第一句完整。第二句也完整。第三句收尾。'

    await delivery.handleEvent('42', { type: 'content_start', blockType: 'text' })
    await delivery.handleEvent('42', { type: 'content_delta', text: '第一句完整。' })
    await Bun.sleep(0)
    await delivery.handleEvent('42', { type: 'content_delta', text: '第二句也完整。第三句收尾。' })
    await Bun.sleep(0)

    expect(delivery.getDeliveryState('42')).toEqual({
      desiredText: answer,
      immutableOffset: 0,
      placeholderDeliveredText: '第一句完整。',
      finalChunksDelivered: 0,
    })

    await delivery.handleEvent('42', { type: 'message_complete' })

    expect(fake.editAttempts).toHaveLength(5)
    expect(fake.sendAttempts.at(-1)).toBe(answer)
    expect(delays).toEqual([1000, 1000])
    expect(warnings.some((message) => message.includes('streaming update failed'))).toBe(true)
    expect(warnings.some((message) => message.includes('falling back to sendMessage'))).toBe(true)
    expect(delivery.hasState('42')).toBe(false)
  })

  it('respects retry_after before retrying a final edit', async () => {
    const fake = createFakeApi({
      editFailures: [{ error_code: 429, parameters: { retry_after: 2 } }],
    })
    const delays: number[] = []
    const delivery = createDelivery(fake.api, { delays })

    await streamReply(delivery, '42', ['complete after retry'])

    expect(fake.editAttempts).toEqual(['complete after retry', 'complete after retry'])
    expect(delays).toEqual([2000])
    expect([...fake.messages.values()]).toEqual(['complete after retry'])
  })

  it('retries a transient middle send without losing or duplicating long-reply chunks', async () => {
    const answer = 'x'.repeat(9000)
    let failed = false
    const fake = createFakeApi({
      sendFailure(text) {
        if (!failed && text.length === 4000) {
          failed = true
          return new TypeError('fetch failed')
        }
        return null
      },
    })
    const delays: number[] = []
    const delivery = createDelivery(fake.api, { delays })

    await streamReply(delivery, '42', [answer])

    expect([...fake.messages.values()].join('')).toBe(answer)
    expect(fake.sendAttempts.filter((text) => text.length === 4000)).toHaveLength(2)
    expect(delays).toEqual([250])
    expect(delivery.hasState('42')).toBe(false)
  })

  it('resumes a long reply from the confirmed prefix after an intermediate send fails', async () => {
    const answer = 'y'.repeat(9000)
    let failed = false
    const fake = createFakeApi({
      sendFailure() {
        if (!failed) {
          failed = true
          return new TypeError('stream socket reset')
        }
        return null
      },
    })
    const warnings: string[] = []
    const delivery = createDelivery(fake.api, {
      bufferCharThreshold: 1,
      warnings,
    })

    await delivery.handleEvent('42', { type: 'content_start', blockType: 'text' })
    await delivery.handleEvent('42', { type: 'content_delta', text: answer })
    await Bun.sleep(0)
    await delivery.handleEvent('42', { type: 'message_complete' })

    expect([...fake.messages.values()].join('')).toBe(answer)
    expect(warnings.some((message) => message.includes('streaming update failed'))).toBe(true)
    expect(delivery.hasState('42')).toBe(false)
  })

  it('retains delivery state when the final fallback cannot be sent', async () => {
    const fake = createFakeApi({
      editFailures: [new Error('edit rejected')],
      sendFailure: () => new Error('send rejected'),
    })
    const delivery = createDelivery(fake.api)

    await delivery.handleEvent('42', { type: 'content_start', blockType: 'text' })
    await delivery.handleEvent('42', { type: 'content_delta', text: 'must survive' })

    await expect(
      delivery.handleEvent('42', { type: 'message_complete' }),
    ).rejects.toThrow('send rejected')
    expect(delivery.hasState('42')).toBe(true)
  })

  it('drops buffered text and detaches the old placeholder when cleared mid-turn', async () => {
    const fake = createFakeApi()
    const delivery = createDelivery(fake.api)

    await delivery.handleEvent('42', { type: 'content_start', blockType: 'text' })
    const oldPlaceholderId = delivery.getPlaceholderMessageId('42')
    await delivery.handleEvent('42', { type: 'content_delta', text: 'abandoned partial text' })

    delivery.clear('42')
    expect(delivery.hasState('42')).toBe(false)

    await streamReply(delivery, '42', ['fresh reply'])

    expect(fake.messages.get(oldPlaceholderId!)).toBe('▍')
    expect([...fake.messages.entries()].filter(([id]) => id !== oldPlaceholderId).map(([, text]) => text)).toEqual(['fresh reply'])
  })

  it('stops an in-flight multi-chunk streaming flush once cleared', async () => {
    let releaseFirstEdit!: () => void
    const firstEditGate = new Promise<void>((resolve) => { releaseFirstEdit = resolve })
    let nextMessageId = 1
    const sends: string[] = []
    const edits: Array<{ messageId: number; text: string }> = []
    const api: TelegramDeliveryApi = {
      async sendMessage(_chatId, text) {
        sends.push(text)
        return { message_id: nextMessageId++ }
      },
      async editMessageText(_chatId, messageId, text) {
        edits.push({ messageId, text })
        if (edits.length === 1) await firstEditGate
        return {}
      },
    }
    const delivery = createDelivery(api, { bufferCharThreshold: 1 })

    await delivery.handleEvent('42', { type: 'content_start', blockType: 'text' })
    await delivery.handleEvent('42', { type: 'content_delta', text: 'z'.repeat(8500) })
    await Bun.sleep(0)
    expect(edits).toHaveLength(1)

    delivery.clear('42')
    releaseFirstEdit()
    await Bun.sleep(10)

    // Only the initial placeholder send happened; no follow-up chunk was sent after clear().
    expect(sends).toEqual(['▍'])
    expect(edits).toHaveLength(1)
  })
})
