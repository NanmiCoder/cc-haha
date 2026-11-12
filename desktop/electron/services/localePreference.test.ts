import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LOCALE_PREFERENCE_FILE,
  localePreferencePath,
  readLocalePreference,
  writeLocalePreference,
} from './localePreference'

describe('locale preference persistence', () => {
  let root: string
  let app: { getPath(name: 'userData'): string }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-locale-preference-'))
    app = { getPath: () => root }
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('treats a missing preference as follow-system mode', () => {
    expect(readLocalePreference(app)).toBeNull()
  })

  it('persists a valid manual locale across service instances', () => {
    writeLocalePreference(app, 'en')

    expect(readLocalePreference(app)).toBe('en')
    expect(JSON.parse(fs.readFileSync(localePreferencePath(app), 'utf8'))).toEqual({
      locale: 'en',
    })
  })

  it('ignores malformed, unsupported, and extra persisted fields', () => {
    fs.writeFileSync(localePreferencePath(app), '{ broken')
    expect(readLocalePreference(app)).toBeNull()

    fs.writeFileSync(localePreferencePath(app), JSON.stringify({ locale: 'fr' }))
    expect(readLocalePreference(app)).toBeNull()

    // Locales stored by older builds that shipped other languages.
    fs.writeFileSync(localePreferencePath(app), JSON.stringify({ locale: 'zh-TW' }))
    expect(readLocalePreference(app)).toBeNull()

    fs.writeFileSync(localePreferencePath(app), JSON.stringify({ locale: 'en', extra: true }))
    expect(readLocalePreference(app)).toBeNull()
  })

  it('stores the preference in the app-owned userData directory', () => {
    expect(localePreferencePath(app)).toBe(path.join(root, LOCALE_PREFERENCE_FILE))
  })
})
