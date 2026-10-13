import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SELECTION_MENU_PLACEMENT,
  normalizeSelectionMenuPlacement,
  persistSelectionMenuPlacement,
  readSelectionMenuPlacement,
  SELECTION_MENU_PLACEMENT_STORAGE_KEY,
  useSelectionMenuPlacementStore,
} from './selectionMenuPlacementStore'

const CHAT_APPEARANCE_KEY = 'cc-haha-chat-appearance'

describe('selection menu placement preference', () => {
  beforeEach(() => {
    localStorage.clear()
    useSelectionMenuPlacementStore.setState({ placement: DEFAULT_SELECTION_MENU_PLACEMENT })
  })

  it('defaults to the upstream rule and rejects anything else', () => {
    expect(DEFAULT_SELECTION_MENU_PLACEMENT).toBe('auto')
    expect(normalizeSelectionMenuPlacement(undefined)).toBe('auto')
    expect(normalizeSelectionMenuPlacement('nonsense')).toBe('auto')
    expect(normalizeSelectionMenuPlacement({ placement: 'above' })).toBe('auto')
    expect(normalizeSelectionMenuPlacement('above')).toBe('above')
  })

  it('reads the upstream rule when the preference was never set', () => {
    expect(readSelectionMenuPlacement()).toBe('auto')
  })

  it('writes only its own key, leaving the reading preferences untouched', () => {
    const appearance = { version: 1, font: 'serif', fontSize: 18, width: 'full' }
    localStorage.setItem(CHAT_APPEARANCE_KEY, JSON.stringify(appearance))

    useSelectionMenuPlacementStore.getState().setPlacement('above')

    expect(useSelectionMenuPlacementStore.getState().placement).toBe('above')
    expect(localStorage.getItem(SELECTION_MENU_PLACEMENT_STORAGE_KEY)).toBe('above')
    // The point of a separate key: changing the bubble position must not rewrite
    // the chat appearance record, so resetting appearance cannot clear it either.
    expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_KEY)!)).toEqual(appearance)
  })

  it('round trips a saved preference', () => {
    persistSelectionMenuPlacement('above')
    expect(readSelectionMenuPlacement()).toBe('above')
    persistSelectionMenuPlacement('auto')
    expect(readSelectionMenuPlacement()).toBe('auto')
  })

  it('falls back safely when storage is corrupt or blocked', () => {
    localStorage.setItem(SELECTION_MENU_PLACEMENT_STORAGE_KEY, 'constructor')
    expect(readSelectionMenuPlacement()).toBe('auto')

    const blocked = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(readSelectionMenuPlacement(blocked)).toBe('auto')
    expect(() => persistSelectionMenuPlacement('above', blocked)).not.toThrow()
  })
})
