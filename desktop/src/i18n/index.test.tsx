import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { translate, useTranslation } from '.'

describe('useTranslation', () => {
  afterEach(() => {
    act(() => {
      useSettingsStore.getState().setLocale('zh')
    })
  })

  it('keeps the translation function stable until the locale changes', () => {
    act(() => {
      useSettingsStore.getState().setLocale('zh')
    })

    const { result, rerender } = renderHook(() => useTranslation())
    const initial = result.current

    rerender()
    expect(result.current).toBe(initial)

    act(() => {
      useSettingsStore.getState().setLocale('en')
    })
    expect(result.current).not.toBe(initial)
  })

  it('resolves every registered locale to its own translation', () => {
    expect(translate('en', 'common.save')).toBe('Save')
    expect(translate('zh', 'common.save')).toBe('保存')
    expect(translate('zh-TW', 'common.save')).toBe('儲存')
    expect(translate('jp', 'common.save')).toBe('保存')
    expect(translate('kr', 'common.save')).toBe('저장')
  })

  it('interpolates params across the new locales', () => {
    expect(translate('jp', 'session.timeMinutes', { n: 5 })).toBe('5 分前')
    expect(translate('kr', 'session.timeMinutes', { n: 5 })).toBe('5분 전')
  })

  it('resolves the recommended-skill catalog descriptions in every locale', () => {
    // Each newly-added catalog entry must have a real, locale-specific
    // description across all five locales — otherwise the desktop Settings →
    // Skills "Recommended" card silently falls back to the English string the
    // server ships. Guards the mattpocock/* + karpathy entries added with the
    // catalog wiring.
    const keys = [
      'settings.skills.catalog.karpathy-guidelines.desc',
      'settings.skills.catalog.mattpocock-grilling.desc',
      'settings.skills.catalog.mattpocock-tdd.desc',
      'settings.skills.catalog.mattpocock-diagnosing-bugs.desc',
    ] as const
    const locales = ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const

    for (const key of keys) {
      for (const locale of locales) {
        const value = translate(locale, key)
        // A missing key returns the key itself; assert we got a real string.
        expect(value, `${locale} / ${key}`).not.toBe(key)
        expect(value.length, `${locale} / ${key}`).toBeGreaterThan(0)
      }
      // The Chinese description must be written natively, not left as English.
      expect(translate('zh', key)).not.toBe(translate('en', key))
    }
  })

  it('resolves the new skill category labels in every locale', () => {
    const keys = [
      'settings.skills.category.engineering',
      'settings.skills.category.productivity',
      'settings.skills.category.workflow',
    ] as const
    for (const key of keys) {
      for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
        expect(translate(locale, key), `${locale} / ${key}`).not.toBe(key)
      }
    }
  })
})
