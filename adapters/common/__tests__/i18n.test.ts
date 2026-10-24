import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ADAPTER_LOCALES,
  DEFAULT_ADAPTER_LOCALE,
  adapterLocaleTag,
  getAdapterLocale,
  handleLanguageCommand,
  normalizeAdapterLocale,
  setAdapterLanguage,
  MESSAGE_KEYS,
  setAdapterLocale,
  t,
  type MessageKey,
} from '../i18n.js'

let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-i18n-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(() => {
  setAdapterLocale('zh')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
})

describe('adapter locale resolution', () => {
  it('defaults to Vietnamese', () => {
    expect(DEFAULT_ADAPTER_LOCALE).toBe('vi')
    expect(ADAPTER_LOCALES).toEqual(['vi', 'en', 'zh', 'zh-TW', 'ja', 'ko'])
  })

  it('normalizes aliases and rejects unknown values', () => {
    expect(normalizeAdapterLocale('VI')).toBe('vi')
    expect(normalizeAdapterLocale('vi-VN')).toBe('vi')
    expect(normalizeAdapterLocale('vn')).toBe('vi')
    expect(normalizeAdapterLocale('zh-CN')).toBe('zh')
    expect(normalizeAdapterLocale('zh-TW')).toBe('zh-TW')
    expect(normalizeAdapterLocale('zh-Hant')).toBe('zh-TW')
    expect(normalizeAdapterLocale('jp')).toBe('ja')
    expect(normalizeAdapterLocale('ja-JP')).toBe('ja')
    expect(normalizeAdapterLocale('kr')).toBe('ko')
    expect(normalizeAdapterLocale('ko-KR')).toBe('ko')
    expect(normalizeAdapterLocale('en-US')).toBe('en')
    expect(normalizeAdapterLocale('fr')).toBeNull()
    expect(normalizeAdapterLocale(undefined)).toBeNull()
  })

  it('exposes a BCP 47 tag for locale-aware date formatting', () => {
    expect(adapterLocaleTag('vi')).toBe('vi-VN')
    expect(adapterLocaleTag('en')).toBe('en-US')
    expect(adapterLocaleTag('zh')).toBe('zh-CN')
    expect(adapterLocaleTag('zh-TW')).toBe('zh-TW')
    expect(adapterLocaleTag('ja')).toBe('ja-JP')
    expect(adapterLocaleTag('ko')).toBe('ko-KR')
  })
})

describe('translations', () => {
  it('translates one key in each supported language', () => {
    setAdapterLocale('vi')
    expect(t('runtime.stopSent')).toBe('Đã gửi tín hiệu dừng.')

    setAdapterLocale('zh')
    expect(t('runtime.stopSent')).toBe('已发送停止信号。')

    setAdapterLocale('en')
    expect(t('runtime.stopSent')).toBe('Stop signal sent.')

    setAdapterLocale('zh-TW')
    expect(t('runtime.stopSent')).toBe('已傳送停止訊號。')

    setAdapterLocale('ja')
    expect(t('runtime.stopSent')).toBe('停止シグナルを送信しました。')

    setAdapterLocale('ko')
    expect(t('runtime.stopSent')).toBe('중지 신호를 보냈습니다.')
    expect(getAdapterLocale()).toBe('ko')
  })

  it('interpolates every occurrence of a parameter', () => {
    setAdapterLocale('vi')
    expect(t('permission.requestMissing', { requestId: 'abc' }))
      .toContain('abc')
    expect(t('status.project', { name: 'demo' })).toBe('Dự án: demo')
  })

  it('contains no Chinese characters in the Vietnamese and English catalogs', () => {
    const cjk = /[一-鿿]/
    for (const locale of ['vi', 'en'] as const) {
      setAdapterLocale(locale)
      for (const key of MESSAGE_KEYS) {
        // The language picker intentionally shows each language in its own script.
        if (key.startsWith('language.name.')) continue
        expect(cjk.test(t(key)), `${locale}:${key} still contains Chinese`).toBe(false)
      }
    }
  })

  it('covers the same keys in every catalog', () => {
    // The Record<MessageKey, string> types enforce this at compile time; this
    // keeps the runtime list honest if a catalog is ever built dynamically.
    expect(new Set(MESSAGE_KEYS).size).toBe(MESSAGE_KEYS.length)
    expect(MESSAGE_KEYS.length).toBeGreaterThan(100)
  })
})

describe('language command', () => {
  it('shows the current language and supported options', () => {
    setAdapterLocale('vi')
    const reply = handleLanguageCommand('/language')
    expect(reply).toContain('Tiếng Việt (vi)')
    expect(reply).toContain('中文 (zh)')
    expect(reply).toContain('English (en)')
    expect(reply).toContain('繁體中文 (zh-TW)')
    expect(reply).toContain('日本語 (ja)')
    expect(reply).toContain('한국어 (ko)')
    expect(reply).toContain('/language')
  })

  it('switches the runtime language and persists it to adapters.json', () => {
    const reply = handleLanguageCommand('/language en')
    expect(reply).toContain('English (en)')
    expect(getAdapterLocale()).toBe('en')

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'adapters.json'), 'utf-8'),
    )
    expect(config.language).toBe('en')
  })

  it('accepts the short and Vietnamese aliases', () => {
    expect(handleLanguageCommand('/lang vi')).not.toBeNull()
    expect(getAdapterLocale()).toBe('vi')

    expect(handleLanguageCommand('/ngon-ngu zh')).not.toBeNull()
    expect(getAdapterLocale()).toBe('zh')
  })

  it('rejects an unsupported language without changing the active one', () => {
    setAdapterLocale('vi')
    const reply = handleLanguageCommand('/language fr')
    expect(reply).toContain('fr')
    expect(getAdapterLocale()).toBe('vi')
  })

  it('ignores ordinary messages', () => {
    expect(handleLanguageCommand('hello')).toBeNull()
    expect(handleLanguageCommand('/status')).toBeNull()
  })

  it('returns null when persistence rejects the locale', () => {
    expect(setAdapterLanguage('klingon')).toBeNull()
  })
})
