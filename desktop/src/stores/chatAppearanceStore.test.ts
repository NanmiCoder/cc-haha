import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_APPEARANCE_STORAGE_KEY, DEFAULT_CHAT_APPEARANCE } from '@/lib/chatAppearance'
import { initializeChatAppearance, useChatAppearanceStore } from './chatAppearanceStore'

describe('chat appearance lifecycle', () => {
  let dispose: (() => void) | undefined
  beforeEach(() => {
    localStorage.clear()
    useChatAppearanceStore.setState({ appearance: { ...DEFAULT_CHAT_APPEARANCE } })
  })
  afterEach(() => { dispose?.(); vi.restoreAllMocks() })

  it('restores preferences before rendering and resets only reading preferences', () => {
    localStorage.setItem('cc-haha-app-zoom', '1.25')
    localStorage.setItem(CHAT_APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, font: 'mono', fontSize: 20, width: 'wide' }))
    dispose = initializeChatAppearance()
    expect(document.documentElement.style.getPropertyValue('--chat-font-size')).toBe('20px')
    expect(useChatAppearanceStore.getState().appearance.width).toBe('wide')
    useChatAppearanceStore.getState().setAppearance({ fontSize: 24 })
    expect(useChatAppearanceStore.getState().appearance.font).toBe('mono')
    expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_STORAGE_KEY)!).fontSize).toBe(24)
    useChatAppearanceStore.getState().resetAppearance()
    expect(useChatAppearanceStore.getState().appearance).toEqual(DEFAULT_CHAT_APPEARANCE)
    expect(localStorage.getItem('cc-haha-app-zoom')).toBe('1.25')
  })

  it('updates other windows without echoing writes and handles key removal', () => {
    dispose = initializeChatAppearance()
    localStorage.setItem(CHAT_APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, fontSize: 19, width: 'full' }))
    const write = vi.spyOn(Storage.prototype, 'setItem')
    window.dispatchEvent(new StorageEvent('storage', { key: CHAT_APPEARANCE_STORAGE_KEY, storageArea: localStorage }))
    expect(useChatAppearanceStore.getState().appearance.fontSize).toBe(19)
    expect(document.documentElement.style.getPropertyValue('--chat-content-max-width')).toBe('100%')
    expect(write).not.toHaveBeenCalled()
    localStorage.removeItem(CHAT_APPEARANCE_STORAGE_KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }))
    expect(useChatAppearanceStore.getState().appearance).toEqual(DEFAULT_CHAT_APPEARANCE)
  })
})
