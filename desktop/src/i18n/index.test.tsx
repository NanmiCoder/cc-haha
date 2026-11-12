import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { translate, useTranslation } from '.'
import { en } from './locales/en'

const locales = { en }

describe('useTranslation', () => {
  afterEach(() => {
    act(() => {
      useSettingsStore.getState().setLocale('en')
    })
  })

  it('keeps the translation function stable across renders', () => {
    const { result, rerender } = renderHook(() => useTranslation())
    const initial = result.current

    rerender()
    expect(result.current).toBe(initial)
  })

  it('resolves keys to English', () => {
    expect(translate('en', 'common.save')).toBe('Save')
  })

  it('interpolates params', () => {
    expect(translate('en', 'session.timeMinutes', { n: 5 })).toContain('5')
  })

  it('localizes pet validation and agent failures', () => {
    for (const locale of ['en'] as const) {
      expect(translate(locale, 'settings.pets.createError.imageDimensions')).not.toBe(
        'settings.pets.createError.imageDimensions',
      )
      expect(translate(locale, 'settings.agents.loadError')).not.toBe('settings.agents.loadError')
    }
  })

  it('localizes the counted activity summary', () => {
    for (const locale of ['en'] as const) {
      const label = translate(locale, 'toolGroup.thoughtMany', { count: 5 })
      expect(label).not.toBe('toolGroup.thoughtMany')
      // The count is what the folded run is showing; a locale that drops the
      // placeholder would silently reduce it back to a bare "Thinking".
      expect(label).toContain('5')
    }
  })

  it('localizes built-in agent overrides and row actions', () => {
    for (const locale of ['en'] as const) {
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
    expect(translate('en', 'settings.general.storagePortableTitle')).toContain('custom')
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
