import { convertMarkdownTablesToBullets, splitMessage } from '../common/format.js'

const DEFAULT_THINKING_PREVIEW_LIMIT = 800

export function formatWhatsAppOutboundText(text: string): string {
  return convertMarkdownTablesToBullets(text).trim()
}

export function buildWhatsAppThinkingPreview(
  currentText: string,
  deltaText: string,
  previewLimit = DEFAULT_THINKING_PREVIEW_LIMIT,
): { fullText: string; messageText: string } {
  const fullText = currentText + deltaText
  const preview = fullText.slice(0, Math.max(0, previewLimit)).trimStart()
  return {
    fullText,
    messageText: preview ? `思考中...\n${preview}` : '思考中...',
  }
}

export function splitWhatsAppText(text: string, limit: number): string[] {
  return splitMessage(formatWhatsAppOutboundText(text), limit).filter((chunk) => chunk.trim())
}
