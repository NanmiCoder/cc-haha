import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAB_BEHAVIOR,
  TAB_BEHAVIOR_STORAGE_KEY,
  persistTabBehavior,
  readTabBehavior,
} from './tabBehavior'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    raw: (key: string) => values.get(key),
  }
}

describe('tab behavior preference', () => {
  it('reads storage written before the setting existed as today\'s behavior', () => {
    // A pre-feature profile: open tabs saved, no tab behavior record.
    const storage = memoryStorage({
      'cc-haha-open-tabs': JSON.stringify({ openTabs: [{ sessionId: 's1', title: 'A', type: 'session' }], activeTabId: 's1' }),
    })
    expect(readTabBehavior(storage)).toEqual({ sessionTabLimit: null, restoreOnLaunch: true })
    expect(storage.raw(TAB_BEHAVIOR_STORAGE_KEY)).toBeUndefined()
  })

  it('round-trips a saved choice', () => {
    const storage = memoryStorage()
    persistTabBehavior({ sessionTabLimit: 8, restoreOnLaunch: false }, storage)
    expect(JSON.parse(storage.raw(TAB_BEHAVIOR_STORAGE_KEY)!)).toEqual({ version: 1, sessionTabLimit: 8, restoreOnLaunch: false })
    expect(readTabBehavior(storage)).toEqual({ sessionTabLimit: 8, restoreOnLaunch: false })
  })

  it.each([
    ['unparseable JSON', '{nope'],
    ['an array', '[]'],
    ['a limit that is not one of the presets', JSON.stringify({ version: 1, sessionTabLimit: 3, restoreOnLaunch: 'no' })],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(readTabBehavior(memoryStorage({ [TAB_BEHAVIOR_STORAGE_KEY]: raw }))).toEqual(DEFAULT_TAB_BEHAVIOR)
  })

  it('reads a record from a newer build as the default without rewriting it', () => {
    const raw = JSON.stringify({ version: 2, sessionTabLimit: 5, restoreOnLaunch: false, groups: true })
    const storage = memoryStorage({ [TAB_BEHAVIOR_STORAGE_KEY]: raw })
    expect(readTabBehavior(storage)).toEqual(DEFAULT_TAB_BEHAVIOR)
    expect(storage.raw(TAB_BEHAVIOR_STORAGE_KEY)).toBe(raw)
  })
})
