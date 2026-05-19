import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Tauri-side modules so importing this file does not crash in jsdom.
// The web-fallback tests deliberately keep these unused; the desktop-side
// behavior is already exercised in `desktopNotifications.test.ts`.
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(),
  UserAttentionType: { Critical: 1, Informational: 2 },
}))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }))

import { notifyDesktop, resetDesktopNotificationsForTests } from './desktopNotifications'
import { useSettingsStore } from '../stores/settingsStore'

describe('desktopNotifications web fallback', () => {
  const originalNotification = (globalThis as { Notification?: unknown }).Notification
  const originalWindow = globalThis.window

  beforeEach(() => {
    resetDesktopNotificationsForTests()
    useSettingsStore.setState({ desktopNotificationsEnabled: true })
    // Browser-like window without Tauri internals.
    ;(globalThis as { window?: unknown }).window = {} as Window
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
  })

  afterEach(() => {
    if (originalNotification) {
      ;(globalThis as { Notification?: unknown }).Notification = originalNotification
    } else {
      delete (globalThis as { Notification?: unknown }).Notification
    }
    if (originalWindow) (globalThis as { window?: unknown }).window = originalWindow
    else delete (globalThis as { window?: unknown }).window
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses Web Notification API when permission granted', async () => {
    const ctorSpy = vi.fn()
    class FakeNotification {
      static permission: NotificationPermission = 'granted'
      static requestPermission = vi.fn().mockResolvedValue('granted' as NotificationPermission)
      constructor(title: string, opts?: NotificationOptions) {
        ctorSpy(title, opts)
      }
    }
    ;(globalThis as { Notification?: unknown }).Notification = FakeNotification

    const result = await notifyDesktop({ title: 't', body: 'b' })
    expect(result).toBe(true)
    expect(ctorSpy).toHaveBeenCalledWith('t', expect.objectContaining({ body: 'b' }))
  })

  it('returns false when permission denied', async () => {
    class FakeNotification {
      static permission: NotificationPermission = 'denied'
      static requestPermission = vi.fn().mockResolvedValue('denied' as NotificationPermission)
      constructor() {}
    }
    ;(globalThis as { Notification?: unknown }).Notification = FakeNotification

    const result = await notifyDesktop({ title: 't', body: 'b' })
    expect(result).toBe(false)
  })

  it('returns false gracefully when Notification API absent', async () => {
    delete (globalThis as { Notification?: unknown }).Notification
    const result = await notifyDesktop({ title: 't', body: 'b' })
    expect(result).toBe(false)
  })
})
