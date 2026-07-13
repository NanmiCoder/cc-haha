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

  it('describes exactly the standard ~/.claude mode and an external custom mode', () => {
    expect(translate('en', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('zh', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('zh-TW', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('jp', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('kr', 'settings.general.storageSystemDescription')).toContain('~/.claude')
    expect(translate('en', 'settings.general.storagePortableTitle')).toContain('custom')
    expect(translate('zh', 'settings.general.storagePortableTitle')).toContain('自定义')
  })
})
