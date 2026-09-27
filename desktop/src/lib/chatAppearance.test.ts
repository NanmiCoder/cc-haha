import { beforeEach, describe, expect, it } from 'vitest'
import { CHAT_APPEARANCE_STORAGE_KEY, DEFAULT_CHAT_APPEARANCE, getChatAppearanceStyle, migrateChatAppearance, normalizeChatAppearance, persistChatAppearance, readChatAppearance } from './chatAppearance'

describe('chat appearance preferences', () => {
  beforeEach(() => localStorage.clear())

  it.each([null, [], 'serif', { font: '__proto__', width: 'constructor', fontSize: NaN }])('rejects malformed preference values: %j', (value) => {
    expect(normalizeChatAppearance(value)).toEqual(DEFAULT_CHAT_APPEARANCE)
  })

  it('bounds and rounds sizes and never interpolates arbitrary CSS', () => {
    expect(normalizeChatAppearance({ fontSize: 100 }).fontSize).toBe(24)
    expect(normalizeChatAppearance({ fontSize: 1 }).fontSize).toBe(12)
    expect(normalizeChatAppearance({ fontSize: 16.6 }).fontSize).toBe(17)
    expect(getChatAppearanceStyle({ font: 'serif', fontSize: 20, width: 'wide' })).toMatchObject({
      '--chat-font-size': '20px', '--chat-content-max-width': '1200px',
    })
    const font = getChatAppearanceStyle(DEFAULT_CHAT_APPEARANCE)['--chat-font-family']
    expect(font).toContain('PingFang SC')
    expect(font).toContain('Microsoft YaHei UI')
    expect(font).not.toContain('SimSun')
  })

  it('round trips preferences while preserving unknown fields', () => {
    localStorage.setItem(CHAT_APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, extra: 'keep' }))
    persistChatAppearance({ font: 'serif', fontSize: 18, width: 'full' })
    expect(readChatAppearance()).toEqual({ font: 'serif', fontSize: 18, width: 'full' })
    expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)!)).toHaveProperty('extra', 'keep')
  })

  it('preserves future schemas through reads, migrations and user changes', () => {
    const raw = JSON.stringify({ version: 2, font: 'future-font', custom: [1, 2] })
    localStorage.setItem(CHAT_APPEARANCE_STORAGE_KEY, raw)
    expect(readChatAppearance()).toEqual(DEFAULT_CHAT_APPEARANCE)
    expect(migrateChatAppearance(localStorage)).toBe(false)
    persistChatAppearance({ font: 'mono', fontSize: 24, width: 'full' })
    expect(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)).toBe(raw)
  })

  it('falls back safely when storage is corrupt or blocked', () => {
    localStorage.setItem(CHAT_APPEARANCE_STORAGE_KEY, '{bad')
    expect(readChatAppearance()).toEqual(DEFAULT_CHAT_APPEARANCE)
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(readChatAppearance(blocked)).toEqual(DEFAULT_CHAT_APPEARANCE)
    expect(() => persistChatAppearance(DEFAULT_CHAT_APPEARANCE, blocked)).not.toThrow()
  })
})
