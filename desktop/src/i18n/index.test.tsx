import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { translate, useTranslation } from '.'
import { en } from './locales/en'
import { zh } from './locales/zh'
import { zh as zhTW } from './locales/zh-TW'
import { jp } from './locales/jp'
import { kr } from './locales/kr'

const locales = { en, zh, 'zh-TW': zhTW, jp, kr }

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

  it('localizes pet validation and agent failures in every registered locale', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
      expect(translate(locale, 'settings.pets.createError.imageDimensions')).not.toBe(
        'settings.pets.createError.imageDimensions',
      )
      expect(translate(locale, 'settings.agents.loadError')).not.toBe('settings.agents.loadError')
    }
  })

  it('localizes the counted activity summary in every registered locale', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
      const label = translate(locale, 'toolGroup.thoughtMany', { count: 5 })
      expect(label).not.toBe('toolGroup.thoughtMany')
      // The count is what the folded run is showing; a locale that drops the
      // placeholder would silently reduce it back to a bare "Thinking".
      expect(label).toContain('5')
    }
  })

  it('localizes built-in agent overrides and row actions in every registered locale', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const) {
      for (const key of [
        'settings.agents.override',
        'settings.agents.overrideTitle',
        'settings.agents.overrideHint',
        'settings.agents.overrideScopeHint',
        'settings.agents.overrideDefaultNone',
        'settings.agents.overrideReset',
        'settings.agents.overrideBadge',
        'settings.agents.overrideSaveError',
        'settings.agents.overrideResetError',
      ] as const) {
        expect(translate(locale, key), `${locale} is missing ${key}`).not.toBe(key)
      }

      // The parameterized ones have to actually substitute: a locale that drops
      // the placeholder would render "Edit " with no agent name, leaving every
      // row action with the same accessible name.
      expect(translate(locale, 'settings.agents.rowEdit', { name: 'Explore' })).toContain('Explore')
      expect(translate(locale, 'settings.agents.rowDelete', { name: 'Explore' })).toContain('Explore')
      expect(translate(locale, 'settings.agents.rowOverride', { name: 'Explore' })).toContain('Explore')
      expect(translate(locale, 'settings.agents.overrideDefault', { value: 'haiku' })).toContain('haiku')
      expect(translate(locale, 'settings.agents.overrideManaged', { source: 'X' })).toContain('X')
      expect(translate(locale, 'settings.agents.overrideShadowed', { source: 'X' })).toContain('X')
    }
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

  // The installed-skills overview was dropped in b64069a3, but the UI rollback
  // right after it restored the locale files wholesale and carried its keys back
  // in. Every locale kept the same key count, so a parity check cannot see this.
  it('carries no key for the removed installed-skills overview', () => {
    for (const [name, locale] of Object.entries(locales)) {
      const resurrected = Object.keys(locale).filter(
        key => key.startsWith('market.installedSkills.') || key === 'market.section.installed',
      )
      expect(resurrected, `${name} still defines removed installed-skills keys`).toEqual([])
    }
  })

  // No index state is surfaced: building/ready/off were already silent, and the
  // degraded fallback only swaps which source the list is read from, so it no
  // longer earns a sidebar row either. Keeping the strings around invites a
  // future change to wire them back into the UI, so they must stay deleted.
  it('carries no key for the silent index states', () => {
    for (const [name, locale] of Object.entries(locales)) {
      const resurrected = Object.keys(locale).filter(key => key.startsWith('sidebar.index'))
      expect(resurrected, `${name} still defines silent index-status keys`).toEqual([])
    }
  })

  // The context popover dropped the "new tokens / API time / subagents excluded"
  // caption. Those numbers duplicate the speed and cost rows above them, and a
  // wholesale locale restore would put the caption back without a key-count check
  // noticing.
  it('carries no key for the removed context-usage caption', () => {
    for (const [name, locale] of Object.entries(locales)) {
      const resurrected = Object.keys(locale).filter(key =>
        key === 'contextIndicator.sessionTotalTokens'
        || key === 'contextIndicator.sessionApiDuration'
        || key === 'contextIndicator.sessionScopeNote',
      )
      expect(resurrected, `${name} still defines the removed context-usage caption`).toEqual([])
    }
  })
})
