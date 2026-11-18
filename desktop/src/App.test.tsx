import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const uninstallHiddenSessionRelease = vi.hoisted(() => vi.fn())
const installHiddenSessionRelease = vi.hoisted(() => vi.fn(() => uninstallHiddenSessionRelease))
const shell = vi.hoisted(() => ({ layout: 'desktop' as 'desktop' | 'phone' | 'tablet' }))

vi.mock('./components/layout/AppShell', () => ({ AppShell: () => null }))
vi.mock('./components/mobile/mobileShellLayout', () => ({ useMobileShellLayout: () => shell.layout }))
vi.mock('./hooks/useScheduledTaskDesktopNotifications', () => ({ useScheduledTaskDesktopNotifications: () => {} }))
vi.mock('./lib/desktopNotificationNavigation', () => ({
  installDesktopNotificationNavigation: () => Promise.resolve(() => {}),
}))
vi.mock('./lib/publicAccessRuntime', () => ({ isPublicAccessRuntime: () => false }))
vi.mock('./stores/hiddenSessionRelease', () => ({ installHiddenSessionRelease }))

import { App } from './App'
import { createDefaultSessionState, useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { usePowerSettingsStore } from './stores/powerSettingsStore'
import { browserHost } from './lib/desktopHost/browserHost'
import { createUnreadCompletion } from './lib/unreadCompletion'

describe('App', () => {
  afterEach(() => {
    cleanup()
    shell.layout = 'desktop'
    installHiddenSessionRelease.mockClear()
    uninstallHiddenSessionRelease.mockClear()
    Reflect.deleteProperty(window, 'desktopHost')
    vi.restoreAllMocks()
  })

  it.each(['MacIntel', 'Win32'])('updates the %s badge for distinct waiting and unread sessions', platform => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    const invoke = vi.fn().mockResolvedValue(true)
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true, commands: { invoke } }
    const idle = createDefaultSessionState()
    const request = { requestId: 'r1', toolName: 'Bash', input: {} }
    const waiting = { ...idle, pendingPermission: request }
    const alsoWaiting = { ...waiting, pendingPermissions: {
      r1: request, r2: { ...request, requestId: 'r2', toolName: 'AskUserQuestion' },
    } }
    const previousSessions = useChatStore.getState().sessions
    const previousUnread = useChatStore.getState().unreadCompletions
    const { desktopNotificationsEnabled, locale } = useSettingsStore.getState()
    const reply = { id: 'reply', type: 'assistant_text', content: 'Done', timestamp: 1 } as const
    const marker = createUnreadCompletion([reply], reply)
    try {
      useChatStore.setState({ sessions: { first: waiting }, unreadCompletions: new Map() })
      useSettingsStore.setState({ desktopNotificationsEnabled: true, locale: 'en' })
      const { unmount } = render(<App />)
      act(() => useChatStore.setState({ sessions: { first: alsoWaiting } }))
      act(() => useChatStore.setState({ sessions: { first: alsoWaiting, second: waiting } }))
      act(() => useChatStore.setState({ unreadCompletions: new Map([['first', marker], ['closed-tab', marker]]) }))
      act(() => useSettingsStore.setState({ desktopNotificationsEnabled: false }))
      act(() => useChatStore.setState({ sessions: { second: waiting } }))
      act(() => useSettingsStore.setState({ desktopNotificationsEnabled: true }))
      act(() => useChatStore.getState().markSessionCompletionRead('first'))
      act(() => useChatStore.getState().markSessionCompletionRead('closed-tab'))
      act(() => useChatStore.setState({ sessions: { second: idle } }))
      unmount()
      useChatStore.setState({ sessions: { first: waiting } })
      expect(invoke.mock.calls).toEqual([1, 2, 3, 0, 3, 2, 1, 0].map(count => [
        'set_notification_badge', { count, description: count ? `Conversations with pending requests or unread replies (${count})` : '' },
      ]))
    } finally {
      useChatStore.setState({ sessions: previousSessions, unreadCompletions: previousUnread })
      useSettingsStore.setState({ desktopNotificationsEnabled, locale })
    }
  })

  it('skips the badge command on Linux', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    const invoke = vi.fn().mockResolvedValue(true)
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true, commands: { invoke } }
    render(<App />)
    expect(invoke).not.toHaveBeenCalledWith('set_notification_badge', expect.anything())
  })

  it('restores the power preference when the desktop app starts without opening settings', async () => {
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true }
    const restore = vi.spyOn(usePowerSettingsStore.getState(), 'restore').mockResolvedValue(undefined)
    await act(async () => { render(<App />) })
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('does not restore native power settings in a browser', () => {
    const restore = vi.spyOn(usePowerSettingsStore.getState(), 'restore').mockResolvedValue(undefined)
    render(<App />)
    expect(restore).not.toHaveBeenCalled()
  })

  // Without it, a tab closed with "Keep running" — or a session the phone has
  // left — holds its CLI and MCP servers for as long as the page lives (#1485).
  it('releases off-screen session sockets for as long as it is mounted', () => {
    const { unmount } = render(<App />)

    expect(installHiddenSessionRelease).toHaveBeenCalledTimes(1)
    expect(installHiddenSessionRelease).toHaveBeenCalledWith(useChatStore, { scope: 'open-tabs' })
    expect(uninstallHiddenSessionRelease).not.toHaveBeenCalled()

    unmount()
    expect(uninstallHiddenSessionRelease).toHaveBeenCalledTimes(1)
  })

  it('treats only the page on screen as shown in the phone and tablet shells', () => {
    shell.layout = 'phone'
    const { rerender } = render(<App />)
    expect(installHiddenSessionRelease).toHaveBeenLastCalledWith(useChatStore, { scope: 'active-tab' })

    // Widening into the desktop layout swaps the rule in place.
    shell.layout = 'desktop'
    rerender(<App />)
    expect(uninstallHiddenSessionRelease).toHaveBeenCalledTimes(1)
    expect(installHiddenSessionRelease).toHaveBeenLastCalledWith(useChatStore, { scope: 'open-tabs' })

    shell.layout = 'tablet'
    rerender(<App />)
    expect(installHiddenSessionRelease).toHaveBeenLastCalledWith(useChatStore, { scope: 'active-tab' })
  })
})
