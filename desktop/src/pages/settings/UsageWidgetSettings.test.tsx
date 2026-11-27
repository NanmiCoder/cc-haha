import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { updatePrefsMock, snapToTopMock, showMock, hideMock, setCompactMock, syncMenuBarMock, notifyPrefsMock } = vi.hoisted(() => ({
  updatePrefsMock: vi.fn(),
  snapToTopMock: vi.fn(async () => ({ compact: true, alwaysOnTop: true, snappedTop: true })),
  showMock: vi.fn(async () => {}),
  hideMock: vi.fn(async () => {}),
  setCompactMock: vi.fn(async () => ({ compact: false, alwaysOnTop: true, snappedTop: false })),
  syncMenuBarMock: vi.fn(async () => {}),
  notifyPrefsMock: vi.fn(async () => {}),
}))

vi.mock('@/api/desktopUiPreferences', async () => {
  const actual = await vi.importActual<typeof import('@/api/desktopUiPreferences')>('@/api/desktopUiPreferences')
  return {
    ...actual,
    desktopUiPreferencesApi: {
      ...actual.desktopUiPreferencesApi,
      updateUsageWidgetPreferences: updatePrefsMock,
    },
  }
})

vi.mock('@/lib/desktopHost', () => ({
  getDesktopHost: () => ({
    isDesktop: true,
    usageWidget: {
      show: showMock,
      hide: hideMock,
      toggle: vi.fn(async () => true),
      setCompact: setCompactMock,
      setAlwaysOnTop: vi.fn(async () => ({ compact: false, alwaysOnTop: true, snappedTop: false })),
      snapToTop: snapToTopMock,
      dragWindow: vi.fn(async () => ({ compact: false, alwaysOnTop: true, snappedTop: false })),
      syncMenuBar: syncMenuBarMock,
      focusMainWindow: vi.fn(async () => {}),
      openSettings: vi.fn(async () => {}),
      notifyPreferencesChanged: notifyPrefsMock,
      onVisibilityChanged: vi.fn(async () => () => {}),
      onPreferencesChanged: vi.fn(async () => () => {}),
    },
  }),
}))

import { UsageWidgetSettings } from './UsageWidgetSettings'
import { DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES } from '@/api/desktopUiPreferences'
import { useUsageSummaryStore } from '@/stores/usageSummaryStore'
import { useSettingsStore } from '@/stores/settingsStore'

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ locale: 'en' })
  useUsageSummaryStore.setState({
    summary: null,
    preferences: { ...DEFAULT_DESKTOP_USAGE_WIDGET_PREFERENCES },
    preferencesLoaded: true,
    isLoading: false,
    error: null,
    popoverOpen: false,
    floatingVisible: false,
  })
  updatePrefsMock.mockImplementation(async (patch) => ({
    ok: true,
    usageWidget: { ...useUsageSummaryStore.getState().preferences, ...patch },
  }))
})

afterEach(() => {
  cleanup()
})

describe('UsageWidgetSettings', () => {
  it('updates sidebar visibility, triggers top-pinned mini bar, and toggles menu bar sync', async () => {
    render(<UsageWidgetSettings />)

    fireEvent.click(screen.getByRole('radio', { name: 'Always' }))
    await waitFor(() => {
      expect(updatePrefsMock).toHaveBeenCalledWith({ sidebarVisibility: 'always' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Pin to top' }))
    await waitFor(() => {
      expect(snapToTopMock).toHaveBeenCalledTimes(1)
    })
    expect(showMock).not.toHaveBeenCalled()
    expect(setCompactMock).not.toHaveBeenCalled()
    expect(notifyPrefsMock).toHaveBeenCalled()

    const menuBarSwitch = screen.getByRole('switch', { name: /Show in menu bar/i })
    fireEvent.click(menuBarSwitch)
    await waitFor(() => {
      expect(syncMenuBarMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
    })
  })
})
