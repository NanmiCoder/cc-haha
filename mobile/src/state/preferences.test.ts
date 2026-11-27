import { describe, expect, test } from 'bun:test'
import {
  desktopFollowSystemKey,
  desktopThemeKey,
  isQuietTime,
  migratePreferences,
  mirrorAppearanceToDesktopWeb,
  preferencesKey,
  PreferencesRepository,
  readDesktopWebAppearance,
  type WebLocalStorageLike,
} from './preferences'

function memoryWebStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  const storage: WebLocalStorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
  return { map, storage }
}

describe('mobile preferences forward migration', () => {
  test('upgrades initial settings without losing future fields or changing consent', () => {
    const migrated = migratePreferences(
      JSON.stringify({
        version: 0,
        appearance: 'dark',
        notifications: { decisions: false, future: 1 },
        extension: 'keep',
      })
    )
    expect(migrated.version).toBe(1)
    expect(migrated.appearance).toBe('dark')
    expect(migrated.notifications.decisions).toBe(false)
    expect(migrated.notifications.completed).toBe(true)
    expect(migrated.notifications).toHaveProperty('future', 1)
    expect(migrated.extension).toBe('keep')
    expect(migratePreferences(JSON.stringify(migrated))).toEqual(migrated)
  })
  test('does not overwrite malformed or future data', async () => {
    for (const raw of [
      '{',
      '{"version":2}',
      'null',
      '{"notifications":{"decisions":"false"}}',
      '{"quietHours":{"start":"invalid"}}',
      '{"notifications":[]}',
    ]) {
      let writes = 0
      const repository = new PreferencesRepository({
        getItem: async () => raw,
        setItem: async () => {
          writes++
        },
        removeItem: async () => {},
      })
      await expect(repository.load()).rejects.toThrow()
      expect(writes).toBe(0)
    }
  })
  test('serializes overlapping setting writes and preserves unrelated values', async () => {
    const values = new Map<string, string>()
    const repository = new PreferencesRepository({
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value)
      },
      removeItem: async (key) => {
        values.delete(key)
      },
    })
    await Promise.all([
      repository.update({ appearance: 'dark' }),
      repository.update({
        quietHours: { enabled: true, start: '23:00', end: '08:00' },
      }),
    ])
    const result = migratePreferences(values.get(preferencesKey)!)
    expect(result.appearance).toBe('dark')
    expect(result.quietHours.enabled).toBe(true)
  })
  test('quiet hours handle midnight and exact start/end boundaries', () => {
    const prefs = migratePreferences(
      '{"quietHours":{"enabled":true,"start":"23:00","end":"08:00"}}'
    )
    for (const [hour, minute, expected] of [
      [22, 59, false],
      [23, 0, true],
      [2, 0, true],
      [7, 59, true],
      [8, 0, false],
    ] as const) {
      const time = new Date(2026, 9, 24, Number(hour), Number(minute))
      expect(isQuietTime(prefs, time)).toBe(expected)
    }
  })
  test('overlapping notification toggles merge against saved state, not a stale render', async () => {
    const values = new Map<string, string>()
    const repository = new PreferencesRepository({
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value)
      },
      removeItem: async (key) => {
        values.delete(key)
      },
    })
    await Promise.all([
      repository.update({ notifications: { decisions: false } }),
      repository.update({ notifications: { completed: false } }),
    ])
    expect((await repository.load()).notifications).toEqual({
      decisions: false,
      completed: false,
      errors: true,
    })
  })
  test('upgrades a pre-0.1.1 saved file: new fields default to the old behaviour', () => {
    const old = JSON.stringify({
      version: 1,
      appearance: 'light',
      notifications: { decisions: true, completed: false, errors: true },
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
    })
    const migrated = migratePreferences(old)
    expect(migrated.liveActivity).toBe('running')
    expect(migrated.liveActivityShowCommand).toBe(true)
    expect(migrated.notifyPrompted).toBe(false)
    expect(migrated.timeSensitive).toBe(true)
    expect(migrated.keepAwake).toBe(false)
    expect(migrated.notifications.completed).toBe(false)
    expect(migrated.quietHours.start).toBe('22:00')
    expect(migratePreferences(JSON.stringify(migrated))).toEqual(migrated)
  })
  test('keeps saved live activity and keepAwake choices and ignores unknown values', () => {
    const kept = migratePreferences(
      '{"liveActivity":"decisions","liveActivityShowCommand":false,"notifyPrompted":true,"keepAwake":true}'
    )
    expect(kept.liveActivity).toBe('decisions')
    expect(kept.liveActivityShowCommand).toBe(false)
    expect(kept.notifyPrompted).toBe(true)
    expect(kept.keepAwake).toBe(true)
    expect(migratePreferences('{"liveActivity":"bogus"}').liveActivity).toBe('running')
    expect(migratePreferences('{"timeSensitive":false}').timeSensitive).toBe(false)
    expect(migratePreferences('{"keepAwake":"yes"}').keepAwake).toBe(false)
  })
  test('updating one new field does not disturb the others', async () => {
    const values = new Map<string, string>()
    const repository = new PreferencesRepository({
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value)
      },
      removeItem: async (key) => {
        values.delete(key)
      },
    })
    await repository.update({ notifyPrompted: true })
    await repository.update({ liveActivity: 'decisions' })
    await repository.update({ keepAwake: true })
    const result = await repository.load()
    expect(result.notifyPrompted).toBe(true)
    expect(result.liveActivity).toBe('decisions')
    expect(result.liveActivityShowCommand).toBe(true)
    expect(result.keepAwake).toBe(true)
  })
  test('migrates legacy multi-theme values cleanly to light or dark', () => {
    for (const legacyLight of ['white', 'paper', 'warm-classic', 'celadon']) {
      expect(migratePreferences(JSON.stringify({ appearance: legacyLight })).appearance).toBe('light')
    }
    for (const legacyDark of ['ink-blue', 'neutral-dark']) {
      expect(migratePreferences(JSON.stringify({ appearance: legacyDark })).appearance).toBe('dark')
    }
    expect(migratePreferences(JSON.stringify({ appearance: 'unknown-theme' })).appearance).toBe('system')
  })
})

describe('H5 same-origin Desktop theme sync', () => {
  test('inherits Desktop theme from localStorage when mobile preferences are unset', async () => {
    const cases: [Record<string, string>, 'light' | 'dark' | 'system'][] = [
      [{ [desktopFollowSystemKey]: '1', [desktopThemeKey]: 'dark' }, 'system'],
      [{ [desktopFollowSystemKey]: '0', [desktopThemeKey]: 'dark' }, 'dark'],
      [{ [desktopFollowSystemKey]: '0', [desktopThemeKey]: 'white' }, 'light'],
      [{ [desktopFollowSystemKey]: '0' }, 'light'],
      [{ [desktopThemeKey]: 'dark' }, 'dark'],
      [{ [desktopThemeKey]: 'white' }, 'light'],
      [{}, 'system'],
    ]
    for (const [initial, expected] of cases) {
      const { storage: webStorage } = memoryWebStorage(initial)
      const repository = new PreferencesRepository(
        {
          getItem: async () => null,
          setItem: async () => {},
          removeItem: async () => {},
        },
        webStorage
      )
      const loaded = await repository.load()
      expect(loaded.appearance).toBe(expected)
    }
  })

  test('stored mobile preferences take precedence over Desktop localStorage keys', async () => {
    const { storage: webStorage } = memoryWebStorage({
      [desktopFollowSystemKey]: '0',
      [desktopThemeKey]: 'dark',
    })
    const repository = new PreferencesRepository(
      {
        getItem: async () => JSON.stringify({ version: 1, appearance: 'light' }),
        setItem: async () => {},
        removeItem: async () => {},
      },
      webStorage
    )
    expect((await repository.load()).appearance).toBe('light')
  })

  test('persisting appearance updates mirrors Desktop localStorage keys on web', async () => {
    const values = new Map<string, string>()
    const { map, storage: webStorage } = memoryWebStorage()
    const repository = new PreferencesRepository(
      {
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => {
          values.set(key, value)
        },
        removeItem: async (key) => {
          values.delete(key)
        },
      },
      webStorage
    )

    await repository.update({ appearance: 'dark' })
    expect(map.get(desktopFollowSystemKey)).toBe('0')
    expect(map.get(desktopThemeKey)).toBe('dark')

    await repository.update({ appearance: 'light' })
    expect(map.get(desktopFollowSystemKey)).toBe('0')
    expect(map.get(desktopThemeKey)).toBe('white')

    await repository.update({ appearance: 'system' })
    expect(map.get(desktopFollowSystemKey)).toBe('1')
  })

  test('updating an unrelated setting before saving appearance preserves inherited Desktop theme', async () => {
    const values = new Map<string, string>()
    const { map, storage: webStorage } = memoryWebStorage({
      [desktopFollowSystemKey]: '0',
      [desktopThemeKey]: 'dark',
    })
    const repository = new PreferencesRepository(
      {
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => {
          values.set(key, value)
        },
        removeItem: async (key) => {
          values.delete(key)
        },
      },
      webStorage
    )

    const updated = await repository.update({ keepAwake: true })
    expect(updated.appearance).toBe('dark')
    expect(map.get(desktopFollowSystemKey)).toBe('0')
    expect(map.get(desktopThemeKey)).toBe('dark')
  })

  test('handles throwing/restricted WebView localStorage gracefully', async () => {
    const throwingWebStorage: WebLocalStorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(readDesktopWebAppearance(throwingWebStorage)).toBeNull()
    expect(() => mirrorAppearanceToDesktopWeb('dark', throwingWebStorage)).not.toThrow()

    const values = new Map<string, string>()
    const repository = new PreferencesRepository(
      {
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => {
          values.set(key, value)
        },
        removeItem: async (key) => {
          values.delete(key)
        },
      },
      throwingWebStorage
    )
    const loaded = await repository.load()
    expect(loaded.appearance).toBe('system')
    const saved = await repository.update({ appearance: 'dark' })
    expect(saved.appearance).toBe('dark')
  })
})
