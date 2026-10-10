import { cleanup, render } from '@testing-library/react'
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
import { useChatStore } from './stores/chatStore'

describe('App', () => {
  afterEach(() => {
    cleanup()
    shell.layout = 'desktop'
    installHiddenSessionRelease.mockClear()
    uninstallHiddenSessionRelease.mockClear()
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
