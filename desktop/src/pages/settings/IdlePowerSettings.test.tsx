import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { DEFAULT_IDLE_POWER_SETTINGS, type IdlePowerState } from '@/lib/idlePower'
import { useIdlePowerStore } from '@/stores/idlePowerStore'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'
import { IdlePowerSettings } from './IdlePowerSettings'

vi.mock('@/lib/desktopNotifications', () => ({
  getDesktopNotificationPermission: async () => 'unsupported',
  getDesktopNotificationPlatform: () => 'other',
  notifyDesktop: vi.fn(),
  openDesktopNotificationSettings: vi.fn(),
  requestDesktopNotificationPermission: async () => 'unsupported',
}))

describe('idle power settings', () => {
  let nativeState: IdlePowerState
  const getState = vi.fn()
  const configure = vi.fn()
  beforeEach(() => {
    vi.resetAllMocks()
    nativeState = {
      settings: { ...DEFAULT_IDLE_POWER_SETTINGS },
      capabilities: { lock: true, sleep: true, hibernate: false, shutdown: true },
      countdown: null, lastAction: null, notice: null,
    }
    getState.mockImplementation(async () => nativeState)
    configure.mockImplementation(async settings => (nativeState = { ...nativeState, settings }))
    window.desktopHost = {
      ...browserHost, kind: 'electron', isDesktop: true,
      power: { ...browserHost.power, getIdleActionState: getState, configureIdleAction: configure },
    }
    useIdlePowerStore.setState(useIdlePowerStore.getInitialState(), true)
    useSettingsStore.setState({ locale: 'en', fetchOutputStyles: async () => {}, fetchAppMode: async () => {} })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
  })
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'desktopHost')
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
  })

  it('exposes default-off controls on General and saves action, scope, and countdown through the host', async () => {
    render(<GeneralSettings />)
    const action = screen.getByRole('combobox', { name: 'When all tasks finish' })
    await waitFor(() => expect(action).toBeEnabled())
    expect(action).toHaveValue('none')
    const scope = screen.getByRole('combobox', { name: 'Trigger after' })
    const countdown = screen.getByRole('combobox', { name: 'Countdown' })
    expect(scope).toBeDisabled()
    expect(countdown).toHaveValue('60')
    expect(within(countdown).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['0', '30', '60', '300'])
    expect(within(action).getByRole('option', { name: 'Hibernate (unavailable)' })).toBeDisabled()
    fireEvent.change(action, { target: { value: 'sleep' } })
    await waitFor(() => expect(action).toHaveValue('sleep'))
    fireEvent.change(scope, { target: { value: 'scheduled' } })
    await waitFor(() => expect(scope).toHaveValue('scheduled'))
    fireEvent.change(countdown, { target: { value: '300' } })
    await waitFor(() => expect(countdown).toHaveValue('300'))
    expect(configure).toHaveBeenLastCalledWith({ action: 'sleep', scope: 'scheduled', countdownSeconds: 300 })
  })

  it('keeps the confirmed choice and a labelled retryable error after saving fails', async () => {
    configure.mockRejectedValueOnce(new Error('fixture persistence error'))
    render(<IdlePowerSettings />)
    const action = screen.getByRole('combobox', { name: 'When all tasks finish' })
    await waitFor(() => expect(action).toBeEnabled())
    fireEvent.change(action, { target: { value: 'shutdown' } })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not save the idle action. Please try again.')
    expect(action).toHaveValue('none')
    expect(action).toBeEnabled()
    expect(action).toHaveAccessibleDescription(alert.textContent!)
    fireEvent.change(action, { target: { value: 'lock' } })
    await waitFor(() => expect(action).toHaveValue('lock'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('refreshes native settings and makes a previously configured unavailable action explicit', async () => {
    getState.mockRejectedValueOnce(new Error('fixture unavailable bridge'))
    render(<IdlePowerSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the idle action. Refresh to try again.')
    nativeState = { ...nativeState, settings: { action: 'hibernate', scope: 'scheduled', countdownSeconds: 30 } }
    fireEvent.click(screen.getByRole('button', { name: 'Refresh idle action' }))
    const action = screen.getByRole('combobox', { name: 'When all tasks finish' })
    await waitFor(() => expect(action).toHaveValue('hibernate'))
    expect(screen.getByText('This action is unavailable on this computer. Choose another action.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(configure).not.toHaveBeenCalled()
  })

  it('hides controls without calling the host in browser and H5 runtimes', async () => {
    window.desktopHost = { ...window.desktopHost!, isDesktop: false, kind: 'browser' }
    await act(async () => { render(<IdlePowerSettings />) })
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(getState).not.toHaveBeenCalled()
  })
})
