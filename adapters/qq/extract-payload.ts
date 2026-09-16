/**
 * Normalize one inbound QQ Open Platform message.
 *
 * The SDK already flattens C2C / group / guild events into `InboundMessage`,
 * but three things still need deciding before the shared runtime sees it: which
 * conversations we accept, what counts as the message text (a voice note only
 * carries an ASR transcript), and which attachments are worth downloading.
 */

export type QqInboundAttachment = {
  content_type?: string
  url?: string
  filename?: string
  size?: number
  asr_refer_text?: string
}

export type QqInboundMessage = {
  kind?: string
  senderId?: string
  senderName?: string
  senderIsBot?: boolean
  content?: string
  messageId?: string
  timestamp?: string
  groupOpenid?: string
  attachments?: QqInboundAttachment[]
}

export type QqInboundPayload = {
  chatId: string
  userId: string
  displayName: string
  text: string
  dedupKey: string
  attachments: QqInboundAttachment[]
}

/**
 * Flatten an inbound message, or return null when it must not be routed.
 *
 * Only C2C (private) chats are accepted. Pairing authorizes a *person*, and a
 * group message would hand that person's authorization to every other member
 * of the group.
 */
export function extractQqPayload(message: QqInboundMessage | undefined): QqInboundPayload | null {
  if (!message) return null
  if (message.kind !== 'c2c') return null
  if (message.senderIsBot) return null

  const userId = message.senderId?.trim()
  if (!userId) return null

  const attachments = (message.attachments ?? []).filter((item) => Boolean(item?.url))
  const transcripts = attachments
    .map((item) => item.asr_refer_text?.trim())
    .filter((value): value is string => Boolean(value))

  const text = [message.content?.trim(), ...transcripts].filter(Boolean).join('\n').trim()
  const messageId = message.messageId?.trim()

  return {
    chatId: userId,
    userId,
    displayName: message.senderName?.trim() || 'QQ User',
    text,
    dedupKey: messageId || `${userId}:${message.timestamp ?? ''}:${text.slice(0, 32)}`,
    // A voice note is fully represented by its transcript; downloading the
    // audio would add an attachment the Agent cannot read.
    attachments: attachments.filter((item) => !item.asr_refer_text),
  }
}
