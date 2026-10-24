import { describe, expect, it, beforeEach } from 'bun:test'
import { getLocale, normalizeLocale, setLocale, t } from '../i18n.js'
import en from '../locales/en.json'
import vi from '../locales/vi.json'
import zh from '../locales/zh.json'

describe('adapter i18n', () => {
  beforeEach(() => {
    setLocale('zh')
  })

  it('normalizes language tags to a supported base locale', () => {
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('en-US')).toBe('en')
    expect(normalizeLocale('vi_VN')).toBe('vi')
    expect(normalizeLocale('zh-Hans')).toBe('zh')
    expect(normalizeLocale('fr')).toBeNull()
    expect(normalizeLocale(undefined)).toBeNull()
  })

  it('defaults to Chinese for unsupported locales', () => {
    expect(setLocale('fr')).toBe('zh')
    expect(getLocale()).toBe('zh')
  })

  it('interpolates named parameters', () => {
    setLocale('en')
    expect(t('status.model', { model: 'deepseek' })).toBe('Model: deepseek')
    setLocale('vi')
    expect(t('status.model', { model: 'deepseek' })).toBe('Mô hình: deepseek')
  })

  it('leaves an unknown placeholder untouched', () => {
    setLocale('en')
    expect(t('status.model')).toBe('Model: {model}')
  })

  it('falls back to the key when no locale defines it', () => {
    expect(t('missing.key', undefined, 'en')).toBe('missing.key')
  })

  it('keeps every locale catalog in sync', () => {
    const zhKeys = Object.keys(zh).sort()
    expect(Object.keys(en).sort()).toEqual(zhKeys)
    expect(Object.keys(vi).sort()).toEqual(zhKeys)
  })

  it('keeps the historical Chinese default for existing installations', () => {
    expect(t('chat.stop.sent')).toBe('已发送停止信号。')
  })
})
