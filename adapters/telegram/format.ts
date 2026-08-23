import {
  convertMarkdownTablesToBullets,
  splitMessage,
} from '../common/format.js'

export function formatTelegramOutboundText(text: string): string {
  return convertMarkdownTablesToBullets(text)
}

export function formatTelegramStreamingText(text: string): string {
  return `${formatTelegramOutboundText(text)} ▍`
}

const DEFAULT_THINKING_PREVIEW_LIMIT = 1000

export type TelegramThinkingUpdate = {
  fullText: string
  messageText: string
}

export function buildTelegramThinkingUpdate(
  currentText: string,
  deltaText: string,
  previewLimit = DEFAULT_THINKING_PREVIEW_LIMIT,
): TelegramThinkingUpdate {
  const fullText = currentText + deltaText
  const preview = fullText.slice(0, Math.max(0, previewLimit)).trimStart()
  return {
    fullText,
    messageText: preview ? `💭 ${preview}...` : '💭 思考中...',
  }
}

export type TelegramStreamingUpdate = {
  sealedChunks: string[]
  activeChunk: string
}

export function planTelegramStreamingUpdate(
  currentText: string,
  deltaText: string,
  limit: number,
): TelegramStreamingUpdate {
  const fullText = currentText + deltaText
  // Reserve 2 chars for the streaming cursor "▍" appended by formatTelegramStreamingText
  if (formatTelegramOutboundText(fullText).length + 2 <= limit) {
    return { sealedChunks: [], activeChunk: fullText }
  }

  const sealedChunks: string[] = []
  let remaining = fullText

  while (formatTelegramOutboundText(remaining).length > limit) {
    const [sealed, rest] = splitOneStreamingChunk(remaining, limit)
    sealedChunks.push(sealed)
    remaining = rest

    if (!remaining) break
  }

  return { sealedChunks, activeChunk: remaining }
}

function splitOneStreamingChunk(text: string, limit: number): [string, string] {
  const roughLimit = Math.min(limit, text.length)
  const candidates = [
    text.lastIndexOf('\n\n', roughLimit),
    text.lastIndexOf('\n', roughLimit),
    text.lastIndexOf('. ', roughLimit),
    text.lastIndexOf(' ', roughLimit),
  ].filter((index) => index > 0)

  for (const candidate of candidates) {
    const splitAt = includeDelimiter(text, candidate)
    const sealed = text.slice(0, splitAt).trimEnd()
    if (sealed && formatTelegramOutboundText(sealed).length <= limit) {
      return [sealed, text.slice(splitAt).trimStart()]
    }
  }

  const chunks = splitMessage(formatTelegramOutboundText(text), limit)
  const firstFormattedChunk = chunks[0] ?? text.slice(0, limit)
  if (firstFormattedChunk.length < text.length && text.startsWith(firstFormattedChunk)) {
    return [firstFormattedChunk.trimEnd(), text.slice(firstFormattedChunk.length).trimStart()]
  }

  const splitAt = Math.max(1, Math.min(limit, text.length))
  return [text.slice(0, splitAt).trimEnd(), text.slice(splitAt).trimStart()]
}

function includeDelimiter(text: string, splitAt: number): number {
  return text[splitAt] === '\n' || text[splitAt] === '.' ? splitAt + 1 : splitAt
}
