import { MessageBuffer } from '../common/message-buffer.js'
import { splitMessage } from '../common/format.js'
import {
  formatTelegramOutboundText,
  formatTelegramStreamingText,
  splitTelegramStreamingChunk,
} from './format.js'

const TELEGRAM_TEXT_LIMIT = 4000
const TELEGRAM_STREAMING_TEXT_LIMIT = TELEGRAM_TEXT_LIMIT - 2
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_NETWORK_RETRY_MS = 250

export type TelegramDeliveryApi = {
  sendMessage: (chatId: number, text: string) => Promise<{ message_id: number }>
  editMessageText: (chatId: number, messageId: number, text: string) => Promise<unknown>
}

export type TelegramStreamEvent =
  | { type: 'content_start'; blockType: string }
  | { type: 'content_delta'; text?: string }
  | { type: 'message_complete' }

type FinalDeliveryPlan = {
  chunks: string[]
  mode: 'edit' | 'send'
  nextChunkIndex: number
}

type DeliveryState = {
  fullText: string
  immutableOffset: number
  placeholderMessageId?: number
  placeholderDeliveredText: string
  finalPlan?: FinalDeliveryPlan
}

export type TelegramStreamDeliveryOptions = {
  bufferIntervalMs?: number
  bufferCharThreshold?: number
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
  warn?: (message: string) => void
}

export type TelegramDeliveryStateSnapshot = {
  desiredText: string
  immutableOffset: number
  placeholderDeliveredText: string
  finalChunksDelivered: number
}

export class TelegramStreamDelivery {
  private readonly states = new Map<string, DeliveryState>()
  private readonly buffers = new Map<string, MessageBuffer>()
  private readonly maxAttempts: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly warn: (message: string) => void

  constructor(
    private readonly api: TelegramDeliveryApi,
    private readonly options: TelegramStreamDeliveryOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.sleep = options.sleep ?? (async (ms) => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms))
    })
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  async handleEvent(chatId: string, event: TelegramStreamEvent): Promise<void> {
    switch (event.type) {
      case 'content_start':
        if (event.blockType === 'text') await this.ensurePlaceholder(chatId, '▍')
        break
      case 'content_delta':
        if (event.text) await this.append(chatId, event.text)
        break
      case 'message_complete':
        await this.complete(chatId)
        break
    }
  }

  hasState(chatId: string): boolean {
    return this.states.has(chatId)
  }

  getPlaceholderMessageId(chatId: string): number | undefined {
    return this.states.get(chatId)?.placeholderMessageId
  }

  getDeliveryState(chatId: string): TelegramDeliveryStateSnapshot | undefined {
    const state = this.states.get(chatId)
    if (!state) return undefined
    return {
      desiredText: state.fullText,
      immutableOffset: state.immutableOffset,
      placeholderDeliveredText: state.placeholderDeliveredText,
      finalChunksDelivered: state.finalPlan?.nextChunkIndex ?? 0,
    }
  }

  async ensurePlaceholder(chatId: string, text: string): Promise<number> {
    const existing = this.states.get(chatId)?.placeholderMessageId
    if (existing !== undefined) return existing

    const sent = await this.api.sendMessage(Number(chatId), text)
    this.states.set(chatId, {
      fullText: '',
      immutableOffset: 0,
      placeholderMessageId: sent.message_id,
      placeholderDeliveredText: '',
    })
    this.getBuffer(chatId)
    return sent.message_id
  }

  async append(chatId: string, text: string): Promise<void> {
    if (!this.states.has(chatId)) await this.ensurePlaceholder(chatId, '▍')
    this.getBuffer(chatId).append(text)
  }

  async complete(chatId: string): Promise<void> {
    const buffer = this.buffers.get(chatId)
    if (buffer) await buffer.complete()

    const state = this.states.get(chatId)
    if (!state) return
    if (!state.fullText.trim()) {
      this.clear(chatId)
      return
    }

    await this.deliverFinal(chatId, state)
    this.clear(chatId)
  }

  clear(chatId: string): void {
    this.buffers.get(chatId)?.reset()
    this.buffers.delete(chatId)
    this.states.delete(chatId)
  }

  private getBuffer(chatId: string): MessageBuffer {
    let buffer = this.buffers.get(chatId)
    if (!buffer) {
      const created = new MessageBuffer(
        async (text, isComplete) => {
          if (this.buffers.get(chatId) !== created) return
          await this.acceptBufferedText(chatId, text, isComplete)
        },
        this.options.bufferIntervalMs,
        this.options.bufferCharThreshold,
      )
      buffer = created
      this.buffers.set(chatId, buffer)
    }
    return buffer
  }

  private async acceptBufferedText(
    chatId: string,
    text: string,
    isComplete: boolean,
  ): Promise<void> {
    const state = this.states.get(chatId)
    if (!state) return

    state.fullText += text
    if (isComplete) return

    try {
      await this.deliverStreaming(chatId, state)
    } catch (err) {
      this.warn(`[Telegram] streaming update failed for ${chatId}; retaining buffered text: ${formatError(err)}`)
    }
  }

  private async deliverStreaming(chatId: string, state: DeliveryState): Promise<void> {
    const numericChatId = Number(chatId)

    while (this.states.get(chatId) === state) {
      const remaining = state.fullText.slice(state.immutableOffset)
      if (formatTelegramOutboundText(remaining).length <= TELEGRAM_STREAMING_TEXT_LIMIT) {
        const messageText = formatTelegramStreamingText(remaining)
        if (state.placeholderMessageId === undefined) {
          const sent = await this.api.sendMessage(numericChatId, messageText)
          state.placeholderMessageId = sent.message_id
        } else {
          await this.api.editMessageText(numericChatId, state.placeholderMessageId, messageText)
        }
        state.placeholderDeliveredText = remaining
        return
      }

      const sealed = splitTelegramStreamingChunk(remaining, TELEGRAM_STREAMING_TEXT_LIMIT)
      const messageText = formatTelegramOutboundText(sealed.text)
      if (state.placeholderMessageId === undefined) {
        await this.api.sendMessage(numericChatId, messageText)
      } else {
        await this.api.editMessageText(numericChatId, state.placeholderMessageId, messageText)
      }

      state.immutableOffset += sealed.consumedLength
      state.placeholderMessageId = undefined
      state.placeholderDeliveredText = ''
    }
  }

  private async deliverFinal(chatId: string, state: DeliveryState): Promise<void> {
    const numericChatId = Number(chatId)
    if (!state.finalPlan) {
      const remaining = state.fullText.slice(state.immutableOffset)
      const chunks = splitMessage(formatTelegramOutboundText(remaining), TELEGRAM_TEXT_LIMIT)
      state.finalPlan = {
        chunks,
        mode: state.placeholderMessageId === undefined ? 'send' : 'edit',
        nextChunkIndex: 0,
      }
    }
    const plan = state.finalPlan

    if (plan.mode === 'edit' && plan.nextChunkIndex === 0) {
      try {
        await this.withFinalRetry(
          () => this.api.editMessageText(
            numericChatId,
            state.placeholderMessageId!,
            plan.chunks[0]!,
          ),
        )
        state.placeholderDeliveredText = plan.chunks[0]!
        plan.nextChunkIndex = 1
      } catch (err) {
        this.warn(`[Telegram] final edit failed for ${chatId}; falling back to sendMessage: ${formatError(err)}`)
        plan.mode = 'send'
      }
    }

    while (plan.nextChunkIndex < plan.chunks.length) {
      const chunk = plan.chunks[plan.nextChunkIndex]!
      await this.withFinalRetry(() => this.api.sendMessage(numericChatId, chunk))
      plan.nextChunkIndex += 1
    }
  }

  private async withFinalRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 1
    while (true) {
      try {
        return await operation()
      } catch (err) {
        const retryDelayMs = getRetryDelayMs(err, attempt)
        if (attempt >= this.maxAttempts || retryDelayMs === null) throw err
        await this.sleep(retryDelayMs)
        attempt += 1
      }
    }
  }
}

function getRetryDelayMs(err: unknown, attempt: number): number | null {
  if (isRecord(err)) {
    const errorCode = numberField(err, 'error_code') ?? numberField(err, 'status') ?? numberField(err, 'statusCode')
    if (errorCode === 429) {
      const parameters = isRecord(err.parameters) ? err.parameters : undefined
      const retryAfterSeconds = parameters ? numberField(parameters, 'retry_after') : undefined
      return Math.max(0, retryAfterSeconds ?? 1) * 1000
    }
  }

  if (err instanceof TypeError) return DEFAULT_NETWORK_RETRY_MS * 2 ** (attempt - 1)

  const code = isRecord(err) && typeof err.code === 'string' ? err.code : ''
  if (/^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_)/.test(code)) {
    return DEFAULT_NETWORK_RETRY_MS * 2 ** (attempt - 1)
  }

  const name = err instanceof Error ? err.name : ''
  const message = formatError(err)
  if (name === 'HttpError' || /fetch failed|network error|socket hang up/i.test(message)) {
    return DEFAULT_NETWORK_RETRY_MS * 2 ** (attempt - 1)
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' ? field : undefined
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
