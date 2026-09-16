/**
 * Normalize one inbound Slack event.
 *
 * Slack pushes far more than user messages down the same socket: edits,
 * deletions, joins, the bot's own replies, and channel traffic. Everything the
 * adapter must *not* answer is filtered here, in one testable place.
 */

export type SlackFile = {
  id?: string
  name?: string
  title?: string
  mimetype?: string
  size?: number
  url_private_download?: string
  url_private?: string
}

export type SlackEvent = {
  type?: string
  subtype?: string
  channel?: string
  channel_type?: string
  user?: string
  bot_id?: string
  app_id?: string
  text?: string
  ts?: string
  thread_ts?: string
  client_msg_id?: string
  files?: SlackFile[]
  hidden?: boolean
}

export type SlackInboundPayload = {
  chatId: string
  userId: string
  text: string
  dedupKey: string
  threadTs?: string
  files: SlackFile[]
}

/**
 * Slack escapes exactly three characters in message text, and nothing else.
 *
 * Skipping this corrupts every message containing them — for a coding agent
 * that means `a && b` arriving as `a &amp;&amp; b`, and any `<`/`>` in a shell
 * redirect, comparison, JSX tag or generic silently mangled.
 */
function decodeSlackEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    // `&amp;` last: decoding it first would turn `&amp;lt;` into `<`.
    .replaceAll('&amp;', '&')
}

/** `<@U123>` and `<#C123|name>` are Slack's wire format for mentions. */
function stripSlackMarkup(text: string): string {
  return decodeSlackEntities(
    text
      .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, '')
      .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, '#$2')
      .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, '$2')
      .replace(/<(https?:\/\/[^|>]+)>/g, '$1'),
  ).trim()
}

/**
 * Subtypes that still carry a real user message.
 *
 * Every other subtype is an edit, a deletion, a join or another non-message
 * event. `file_share` is the exception that matters: Slack delivers a DM with
 * an attachment as a subtyped message, so treating all subtypes as noise drops
 * the attachment *and* the caption the user typed with it.
 */
const USER_MESSAGE_SUBTYPES = new Set(['file_share'])

export type ExtractSlackOptions = {
  /** The bot's own user id, so its replies are never treated as input. */
  botUserId?: string
}

export function extractSlackPayload(
  event: SlackEvent | undefined,
  options: ExtractSlackOptions = {},
): SlackInboundPayload | null {
  if (!event) return null
  if (event.type !== 'message') return null
  if (event.subtype && !USER_MESSAGE_SUBTYPES.has(event.subtype)) return null
  if (event.hidden) return null
  // Bot messages include our own replies; answering them is an infinite loop.
  if (event.bot_id) return null
  // Direct messages only: pairing authorizes one person, and a channel would
  // extend that person's authorization to everyone else in it.
  if (event.channel_type !== 'im') return null

  const chatId = event.channel?.trim()
  const userId = event.user?.trim()
  if (!chatId || !userId) return null
  if (options.botUserId && userId === options.botUserId) return null

  const files = (event.files ?? []).filter((file) => Boolean(file?.url_private_download || file?.url_private))
  const text = stripSlackMarkup(event.text ?? '')
  if (!text && files.length === 0) return null

  return {
    chatId,
    userId,
    text,
    dedupKey: event.client_msg_id?.trim() || `${chatId}:${event.ts ?? ''}`,
    threadTs: event.thread_ts,
    files,
  }
}
