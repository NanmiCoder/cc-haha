import { describe, it, expect } from 'bun:test'
import { splitMessage, formatPermissionRequest, escapeMarkdownV2 } from '../../common/format.js'
import { parsePermitCallbackData } from '../../common/permission.js'
import {
  buildTelegramThinkingUpdate,
  formatTelegramOutboundText,
  formatTelegramStreamingText,
  planTelegramStreamingUpdate,
} from '../format.js'

/**
 * Telegram Adapter 翻译逻辑测试
 *
 * 由于 grammy Bot 需要实际 Token 才能初始化，
 * 这里测试的是不依赖 Bot 实例的核心翻译逻辑。
 */

describe('Telegram message formatting', () => {
  describe('long message splitting', () => {
    it('splits messages at Telegram 4096 char limit', () => {
      const longText = 'a'.repeat(8000)
      const chunks = splitMessage(longText, 4000)
      expect(chunks.length).toBe(2)
      expect(chunks[0]!.length).toBeLessThanOrEqual(4000)
      expect(chunks[1]!.length).toBeLessThanOrEqual(4000)
    })

    it('keeps short messages as single chunk', () => {
      const chunks = splitMessage('Hello World', 4000)
      expect(chunks).toEqual(['Hello World'])
    })

    it('splits at paragraph boundary when possible', () => {
      const text = 'A'.repeat(2000) + '\n\n' + 'B'.repeat(2000)
      const chunks = splitMessage(text, 3000)
      expect(chunks.length).toBe(2)
    })
  })

  describe('Telegram outbound text formatting', () => {
    it('converts markdown tables to bullets before sending', () => {
      const markdown = [
        '| Feature | Status |',
        '| --- | --- |',
        '| Telegram | Done |',
      ].join('\n')

      expect(formatTelegramOutboundText(markdown)).toBe([
        'Telegram',
        '• Status: Done',
      ].join('\n'))
    })

    it('converts markdown tables during streaming updates too', () => {
      const markdown = [
        '| Feature | Status |',
        '| --- | --- |',
        '| Telegram | Streaming |',
      ].join('\n')

      expect(formatTelegramStreamingText(markdown)).toBe([
        'Telegram',
        '• Status: Streaming ▍',
      ].join('\n'))
    })
  })

  describe('Telegram streaming updates', () => {
    it('keeps short streaming text in the active editable chunk', () => {
      expect(planTelegramStreamingUpdate('Hello', ' World', 4000)).toEqual({
        sealedChunks: [],
        activeChunk: 'Hello World',
      })
    })

    it('seals overflowing streaming text and carries the remainder forward', () => {
      const result = planTelegramStreamingUpdate('a'.repeat(3990), 'b'.repeat(50), 4000)

      expect(result.sealedChunks.length).toBe(1)
      expect(result.sealedChunks[0]!.length).toBeLessThanOrEqual(4000)
      expect(result.activeChunk).toBe('b'.repeat(40))
    })

    it('can seal multiple chunks from one large buffered flush', () => {
      const result = planTelegramStreamingUpdate('', 'x'.repeat(8500), 4000)

      expect(result.sealedChunks.length).toBe(2)
      expect(result.sealedChunks.every((chunk) => chunk.length <= 4000)).toBe(true)
      expect(result.activeChunk.length).toBe(500)
    })

    it('keeps an exact-limit remainder editable instead of emitting an empty active chunk', () => {
      const result = planTelegramStreamingUpdate('', 'x'.repeat(8000), 4000)

      expect(result.sealedChunks).toEqual(['x'.repeat(4000)])
      expect(result.activeChunk).toBe('x'.repeat(4000))
    })
  })

  describe('Telegram thinking updates', () => {
    it('accumulates thinking deltas before formatting the preview', () => {
      const first = buildTelegramThinkingUpdate('', 'The user')
      const second = buildTelegramThinkingUpdate(first.fullText, ' wants a long answer')

      expect(second.fullText).toBe('The user wants a long answer')
      expect(second.messageText).toBe('💭 The user wants a long answer...')
    })

    it('caps long thinking previews while keeping the full accumulated text', () => {
      const result = buildTelegramThinkingUpdate('abcdef', 'ghij', 6)

      expect(result.fullText).toBe('abcdefghij')
      expect(result.messageText).toBe('💭 abcdef...')
    })
  })

  describe('permission request formatting', () => {
    it('formats Bash command request', () => {
      const result = formatPermissionRequest('Bash', { command: 'npm test' }, 'abcde')
      expect(result).toContain('🔐')
      expect(result).toContain('Bash')
      expect(result).toContain('npm test')
      expect(result).toContain('abcde')
    })

    it('formats Write file request', () => {
      const result = formatPermissionRequest(
        'Write',
        { file_path: '/src/index.ts', content: 'console.log("hello")' },
        'fghij',
      )
      expect(result).toContain('Write')
      expect(result).toContain('index.ts')
      expect(result).toContain('fghij')
    })

    it('truncates long input in permission request', () => {
      const longInput = { command: 'x'.repeat(500) }
      const result = formatPermissionRequest('Bash', longInput, 'xxxxx')
      expect(result.length).toBeLessThan(600)
    })
  })

  describe('callback_data parsing', () => {
    it('parses permit:requestId:yes format', () => {
      expect(parsePermitCallbackData('permit:abcde:yes')).toEqual({ requestId: 'abcde', allowed: true })
    })

    it('parses permit:requestId:always format', () => {
      expect(parsePermitCallbackData('permit:abcde:always')).toEqual({
        requestId: 'abcde',
        allowed: true,
        rule: 'always',
      })
    })

    it('parses permit:requestId:no format', () => {
      expect(parsePermitCallbackData('permit:abcde:no')).toEqual({ requestId: 'abcde', allowed: false })
    })

    it('ignores non-permit callbacks', () => {
      const data = 'other:action'
      expect(data.startsWith('permit:')).toBe(false)
    })
  })

  describe('MarkdownV2 escaping', () => {
    it('escapes underscores', () => {
      expect(escapeMarkdownV2('hello_world')).toBe('hello\\_world')
    })

    it('escapes multiple special chars', () => {
      const result = escapeMarkdownV2('file.ts (line 42)')
      expect(result).toBe('file\\.ts \\(line 42\\)')
    })

    it('handles code blocks safely', () => {
      const result = escapeMarkdownV2('`code`')
      expect(result).toBe('\\`code\\`')
    })
  })

})
