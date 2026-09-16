/**
 * Normalize one inbound Enterprise WeChat message body.
 *
 * The WebSocket channel delivers six message shapes (text / image / mixed /
 * voice / file / video) that all carry their text in a different place. This
 * module flattens them into the fields the shared chat runtime needs, and is
 * the only place that knows those shapes.
 */

export type WecomInboundBody = {
  msgid?: string
  aibotid?: string
  chatid?: string
  chattype?: 'single' | 'group' | string
  msgtype?: string
  from?: { userid?: string }
  create_time?: number
  text?: { content?: string }
  voice?: { content?: string }
  mixed?: { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> }
  quote?: {
    msgtype?: string
    text?: { content?: string }
    voice?: { content?: string }
    mixed?: { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> }
  }
}

export type WecomInboundPayload = {
  /** Conversation key: the sender's userid, since only 1:1 chats are routed. */
  chatId: string
  userId: string
  text: string
  dedupKey: string
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function mixedText(
  mixed: { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> } | undefined,
): string {
  return (mixed?.msg_item ?? [])
    .filter((item) => item.msgtype === 'text')
    .map((item) => cleanText(item.text?.content))
    .filter(Boolean)
    .join('\n')
}

/** The user-visible text of a message, whatever shape carried it. */
export function extractWecomText(body: WecomInboundBody | undefined): string {
  if (!body) return ''
  const parts = [
    cleanText(body.text?.content),
    // WeCom transcribes voice server-side, so a voice note is plain text here.
    cleanText(body.voice?.content),
    mixedText(body.mixed),
  ].filter(Boolean)
  return parts.join('\n').trim()
}

/** The text of a quoted message, used as context for the Agent. */
export function extractWecomQuoteText(body: WecomInboundBody | undefined): string {
  const quote = body?.quote
  if (!quote) return ''
  const parts = [
    cleanText(quote.text?.content),
    cleanText(quote.voice?.content),
    mixedText(quote.mixed),
  ].filter(Boolean)
  return parts.join('\n').trim()
}

/**
 * Flatten an inbound body, or return null when it cannot be routed.
 *
 * A message with no sender userid has no identity to authorize, and a group
 * message would answer in a room where pairing authorized only one member —
 * both are dropped here rather than downstream, so the runtime only ever sees
 * routable private messages.
 */
export function extractWecomPayload(
  body: WecomInboundBody | undefined,
): WecomInboundPayload | null {
  if (!body) return null
  const userId = cleanText(body.from?.userid)
  if (!userId) return null
  if (body.chattype === 'group') return null

  const chatId = userId

  const quoted = extractWecomQuoteText(body)
  const body_text = extractWecomText(body)
  const text = quoted ? `> ${quoted.replace(/\n/g, '\n> ')}\n\n${body_text}`.trim() : body_text

  return {
    chatId,
    userId,
    text,
    dedupKey: cleanText(body.msgid) || `${chatId}:${body.create_time ?? ''}:${body_text.slice(0, 32)}`,
  }
}
