import {
  convertMarkdownTablesToBullets,
  splitMessage,
} from '../common/format.js'
import { t } from '../common/i18n.js'

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
    messageText: preview ? `💭 ${preview}...` : `💭 ${t('thinking.indicator')}`,
  }
}

export type TelegramStreamingUpdate = {
  sealedChunks: string[]
  activeChunk: string
}

export type TelegramStreamingChunk = {
  text: string
  remainder: string
  consumedLength: number
}

export function planTelegramStreamingUpdate(
  currentText: string,
  deltaText: string,
  limit: number,
): TelegramStreamingUpdate {
  const fullText = currentText + deltaText
  if (formatTelegramOutboundText(fullText).length <= limit) {
    return { sealedChunks: [], activeChunk: fullText }
  }

  const sealedChunks: string[] = []
  let remaining = fullText

  while (formatTelegramOutboundText(remaining).length > limit) {
    const chunk = splitTelegramStreamingChunk(remaining, limit)
    sealedChunks.push(chunk.text)
    remaining = chunk.remainder

    if (!remaining) break
  }

  return { sealedChunks, activeChunk: remaining }
}

export function splitTelegramStreamingChunk(
  text: string,
  limit: number,
): TelegramStreamingChunk {
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
      return buildStreamingChunk(text, sealed, splitAt)
    }
  }

  const chunks = splitMessage(formatTelegramOutboundText(text), limit)
  const firstFormattedChunk = chunks[0] ?? text.slice(0, limit)
  if (firstFormattedChunk.length < text.length && text.startsWith(firstFormattedChunk)) {
    return buildStreamingChunk(text, firstFormattedChunk.trimEnd(), firstFormattedChunk.length)
  }

  const splitAt = Math.max(1, Math.min(limit, text.length))
  return buildStreamingChunk(text, text.slice(0, splitAt).trimEnd(), splitAt)
}

function includeDelimiter(text: string, splitAt: number): number {
  return text[splitAt] === '\n' || text[splitAt] === '.' ? splitAt + 1 : splitAt
}

function buildStreamingChunk(
  source: string,
  text: string,
  splitAt: number,
): TelegramStreamingChunk {
  let consumedLength = splitAt
  while (consumedLength < source.length && /\s/.test(source[consumedLength]!)) {
    consumedLength += 1
  }
  return {
    text,
    remainder: source.slice(consumedLength),
    consumedLength,
  }
}
