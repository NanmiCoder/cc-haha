import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { PREVENT_SLEEP_STORAGE_KEY } from '@/lib/preventSleepPreference'
import { useSettingsStore } from '@/stores/settingsStore'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { usePowerSettingsStore } from '@/stores/powerSettingsStore'
import { GeneralSettings } from './GeneralSettings'

vi.mock('@/lib/desktopNotifications', () => ({
  getDesktopNotificationPermission: async () => 'unsupported',
  getDesktopNotificationPlatform: () => 'other',
  notifyDesktop: vi.fn(),
  openDesktopNotificationSettings: vi.fn(),
  requestDesktopNotificationPermission: async () => 'unsupported',
}))

describe('General settings prevent sleep', () => {
  const setEnabled = vi.fn(async (_enabled: boolean) => {})
  beforeEach(() => {
    localStorage.clear()
    setEnabled.mockReset().mockResolvedValue(undefined)
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true,
      power: { setPreventSleepWhileRunning: setEnabled } }
    usePowerSettingsStore.setState({ preventSleepWhileRunning: false, saving: false, error: false })
    useSettingsStore.setState({ locale: 'zh', fetchOutputStyles: async () => {}, fetchAppMode: async () => {} })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
  })
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'desktopHost')
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
  })

  it('exposes the default-off switch on the actual General page and persists on/off', async () => {
    render(<GeneralSettings />)
    const toggle = screen.getByRole('switch', { name: '运行任务时防止系统休眠' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(setEnabled).toHaveBeenLastCalledWith(true)
    expect(localStorage.getItem(PREVENT_SLEEP_STORAGE_KEY)).toBe('1')
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(setEnabled).toHaveBeenLastCalledWith(false)
  })

  it('keeps the previous choice and displays an actionable error after a rejected save', async () => {
    setEnabled.mockRejectedValueOnce(new Error('fixture native failure'))
    render(<GeneralSettings />)
    const toggle = screen.getByRole('switch', { name: '运行任务时防止系统休眠' })
    fireEvent.click(toggle)
    expect(await screen.findByRole('alert')).toHaveTextContent('保存防休眠设置失败，请重试。')
    expect(toggle).not.toBeChecked()
    expect(toggle).not.toBeDisabled()
  })

  it('hides the native setting in browser and H5 runtimes', async () => {
    Reflect.deleteProperty(window, 'desktopHost')
    await act(async () => { render(<GeneralSettings />) })
    expect(screen.queryByRole('switch', { name: '运行任务时防止系统休眠' })).not.toBeInTheDocument()
  })
})
