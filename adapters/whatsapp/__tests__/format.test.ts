import { describe, expect, it } from 'bun:test'
import {
  buildWhatsAppThinkingPreview,
  formatWhatsAppOutboundText,
  splitWhatsAppText,
} from '../format.js'

describe('WhatsApp message formatting', () => {
  it('converts markdown tables to mobile-friendly bullets', () => {
    const markdown = [
      '| Feature | Status |',
      '| --- | --- |',
      '| WhatsApp | Ready |',
    ].join('\n')

    expect(formatWhatsAppOutboundText(markdown)).toBe([
      'WhatsApp',
      '• Status: Ready',
    ].join('\n'))
  })

  it('splits long text within the WhatsApp chunk limit', () => {
    const chunks = splitWhatsAppText('a'.repeat(8100), 4000)

    expect(chunks).toHaveLength(3)
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true)
  })

  it('accumulates thinking preview text without losing the full value', () => {
    const first = buildWhatsAppThinkingPreview('', 'The user')
    const second = buildWhatsAppThinkingPreview(first.fullText, ' asks for WhatsApp')

    expect(second.fullText).toBe('The user asks for WhatsApp')
    expect(second.messageText).toContain('The user asks for WhatsApp')
  })
})
