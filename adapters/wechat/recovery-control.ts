import { extractWechatText, type WechatMessage } from './protocol.js'
import { wechatMessageKey } from './delivery-runtime.js'

/** Bounded diagnostic escape hatch when no durable admission is possible.
 * It never submits model work, approves a tool, retries a reply or advances the cursor. */
export async function handleWechatJournalFull(messages: WechatMessage[], deps: {
  allowed: (chatId: string) => boolean
  first: (key: string) => boolean
  context: (chatId: string, token?: string) => void
  stop: (chatId: string) => void
  summary: (chatId: string) => string
  reply: (chatId: string, text: string) => Promise<void>
}): Promise<void> {
  for (const message of messages.slice(0, 100)) {
    const chatId = message?.from_user_id
    if (!chatId || !deps.allowed(chatId)) continue
    const text = extractWechatText(message.item_list).trim()
    if (!['/delivery', '/stop', '停止'].includes(text)) continue
    if (!deps.first(`journal-full:${wechatMessageKey(message)}`)) continue
    deps.context(chatId, message.context_token)
    if (text !== '/delivery') deps.stop(chatId)
    await deps.reply(chatId, `Message record storage is full; regular tasks are not being accepted yet and the receive position has not advanced. ${text === '/delivery' ? '' : 'Cancelled local media processing and tried to stop the currently connected task.'}\n${deps.summary(chatId)}`)
  }
}
