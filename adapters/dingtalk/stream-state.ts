import type { MessageBuffer } from '../common/message-buffer.js'
import type { DingTalkAiCardInstance, DingTalkAiCardService } from './ai-card.js'

export type DingTalkStreamingState = {
  aiCardBuffers: Map<string, MessageBuffer>
  streamingCards: Map<string, Promise<DingTalkAiCardInstance | null>>
  streamingCardText: Map<string, string>
  finalize?: () => Promise<void>
}

type DingTalkStreamingDelivery = {
  getOrCreateCard: () => Promise<DingTalkAiCardInstance | null> | null
  sendText: (text: string, onChunkDelivered?: (remainingText: string) => void) => Promise<void>
  aiCards: Pick<DingTalkAiCardService, 'stream' | 'finish'>
}

export async function flushDingTalkAiCard(
  state: DingTalkStreamingState,
  chatId: string,
  newText: string,
  isComplete: boolean,
  delivery: DingTalkStreamingDelivery,
): Promise<void> {
  const fullText = (state.streamingCardText.get(chatId) ?? '') + newText
  state.streamingCardText.set(chatId, fullText)
  if (!fullText.trim()) return

  const cardPromise = delivery.getOrCreateCard()
  const card = cardPromise ? await cardPromise : null
  const sendRemainingText = () => delivery.sendText(fullText, remainingText => {
    state.streamingCardText.set(chatId, remainingText)
  })
  if (!card) {
    if (isComplete) {
      await sendRemainingText()
      // Terminal markdown delivery consumes the same state as a finished card.
      // Otherwise finishAndReset will finalize this text a second time.
      resetDingTalkStreamingState(state, chatId)
    }
    return
  }

  try {
    if (isComplete) {
      await delivery.aiCards.finish(card, fullText)
      resetDingTalkStreamingState(state, chatId)
    } else {
      await delivery.aiCards.stream(card, `${fullText} ▍`, false)
    }
  } catch (err) {
    console.warn('[DingTalk][AICard] stream failed, falling back to markdown:', err instanceof Error ? err.message : err)
    state.streamingCards.delete(chatId)
    if (isComplete) {
      await sendRemainingText()
      resetDingTalkStreamingState(state, chatId)
    }
  }
}

export function resetDingTalkStreamingState(
  state: DingTalkStreamingState,
  chatId: string,
): void {
  state.aiCardBuffers.get(chatId)?.reset()
  state.aiCardBuffers.delete(chatId)
  state.streamingCards.delete(chatId)
  state.streamingCardText.delete(chatId)
}

export async function finishAndResetDingTalkStreamingState(
  state: DingTalkStreamingState,
  chatId: string,
): Promise<void> {
  await state.aiCardBuffers.get(chatId)?.complete()
  if (state.finalize && (state.streamingCards.has(chatId) || state.streamingCardText.has(chatId))) {
    await state.finalize()
  }
  resetDingTalkStreamingState(state, chatId)
}
