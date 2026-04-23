import { describe, it, expect } from 'bun:test'
import { splitMessage, formatPermissionRequest, truncateInput, escapeMarkdownV2 } from '../../common/format.js'

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
      const data = 'permit:abcde:yes'
      const parts = data.split(':')
      expect(parts[0]).toBe('permit')
      expect(parts[1]).toBe('abcde')
      expect(parts[2]).toBe('yes')
    })

    it('parses permit:requestId:no format', () => {
      const data = 'permit:abcde:no'
      const parts = data.split(':')
      expect(parts[2]).toBe('no')
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

  describe('whitelist logic', () => {
    it('empty allowedUsers means allow all', () => {
      const allowedUsers: number[] = []
      const isAllowed = (userId: number) =>
        allowedUsers.length === 0 || allowedUsers.includes(userId)
      expect(isAllowed(12345)).toBe(true)
      expect(isAllowed(99999)).toBe(true)
    })

    it('non-empty allowedUsers filters correctly', () => {
      const allowedUsers = [111, 222]
      const isAllowed = (userId: number) =>
        allowedUsers.length === 0 || allowedUsers.includes(userId)
      expect(isAllowed(111)).toBe(true)
      expect(isAllowed(222)).toBe(true)
      expect(isAllowed(333)).toBe(false)
    })
  })
})
