import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { DEFAULT_IDLE_POWER_SETTINGS, type IdlePowerState } from '@/lib/idlePower'
import { useIdlePowerStore } from '@/stores/idlePowerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { usePowerSettingsStore } from '@/stores/powerSettingsStore'
import { createDefaultSessionState, settleAgentRunSession, useChatStore } from '@/stores/chatStore'
import { IdlePowerStatus } from './IdlePowerStatus'
import { App } from '@/App'

vi.mock('@/components/layout/AppShell', () => ({ AppShell: () => <div>App shell</div> }))
vi.mock('@/components/mobile/mobileShellLayout', () => ({ useMobileShellLayout: () => 'desktop' }))
vi.mock('@/hooks/useScheduledTaskDesktopNotifications', () => ({ useScheduledTaskDesktopNotifications: () => {} }))
vi.mock('@/lib/desktopNotificationNavigation', () => ({ installDesktopNotificationNavigation: async () => () => {} }))
vi.mock('@/lib/publicAccessRuntime', () => ({ isPublicAccessRuntime: () => false }))
vi.mock('@/stores/hiddenSessionRelease', () => ({ installHiddenSessionRelease: () => () => {} }))
vi.mock('@/stores/sessionTabLimit', () => ({ installSessionTabLimit: () => () => {} }))

describe('global idle power status', () => {
  let nativeState: IdlePowerState
  let listener: ((state: IdlePowerState) => void) | undefined
  const cancel = vi.fn()
  const unlisten = vi.fn()
  const listen = vi.fn()
  beforeEach(() => {
    vi.resetAllMocks()
    listener = undefined
    nativeState = {
      settings: { ...DEFAULT_IDLE_POWER_SETTINGS, action: 'sleep' },
      capabilities: { lock: true, sleep: true, hibernate: false, shutdown: true },
      countdown: { id: 'countdown-1', action: 'sleep', deadline: Date.now() + 60_000 },
      lastAction: null, notice: null,
    }
    cancel.mockImplementation(async () => { nativeState = { ...nativeState, countdown: null, notice: 'cancelled' } })
    listen.mockImplementation(async handler => { listener = handler; return unlisten })
    window.desktopHost = {
      ...browserHost, kind: 'electron', isDesktop: true,
      power: { ...browserHost.power, getIdleActionState: async () => nativeState,
        cancelIdleAction: cancel, onIdleActionState: listen },
    }
    useIdlePowerStore.setState({ ...useIdlePowerStore.getInitialState(), snapshot: nativeState }, true)
    useSettingsStore.setState({ locale: 'en' })
    vi.spyOn(usePowerSettingsStore.getState(), 'restore').mockResolvedValue(undefined)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'desktopHost')
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  })

  it('shows a decreasing countdown globally and replaces it only after native cancellation', async () => {
    vi.useFakeTimers()
    render(<IdlePowerStatus />)
    expect(screen.getByText('Sleep in 60 seconds.')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText('Sleep in 59 seconds.')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel idle action' })) })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Sleep in/)).not.toBeInTheDocument()
    expect(screen.getByText('Idle action cancelled.')).toBeInTheDocument()
  })

  it('keeps cancellation available and shows failure when the native request fails', async () => {
    cancel.mockRejectedValueOnce(new Error('fixture bridge failure'))
    render(<IdlePowerStatus />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel idle action' }))
    expect(await screen.findByText('Could not cancel the idle action. Please try again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel idle action' })).toBeEnabled()
    expect(screen.getByText('Sleep in 60 seconds.')).toBeInTheDocument()
  })

  it.each([
    ['user-activity', 'Idle action cancelled because keyboard or mouse activity was detected.'],
    ['new-work', 'Idle action cancelled because new work started.'],
    ['unavailable', 'Idle action cancelled because it is unavailable on this computer.'],
    ['failed', 'The idle action request failed.'],
  ] as const)('updates from the global App subscription when %s arrives', async (notice, text) => {
    const { unmount } = render(<App />)
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1))
    act(() => listener?.({ ...nativeState, countdown: null, notice }))
    expect(screen.queryByText(/Sleep in/)).not.toBeInTheDocument()
    expect(screen.getByText(text)).toBeInTheDocument()
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('keeps App power status owned by the host when a local SubAgent settles or remains stale', async () => {
    const previousSessions = useChatStore.getState().sessions
    const tabId = '__subagent__power-boundary__tool-1'
    const configure = vi.fn(async () => nativeState)
    const readState = vi.fn(async () => nativeState)
    nativeState = { ...nativeState, countdown: null }
    window.desktopHost!.power = {
      ...window.desktopHost!.power,
      getIdleActionState: readState,
      configureIdleAction: configure,
    }
    useIdlePowerStore.setState({ snapshot: null })
    useChatStore.setState({ sessions: {
      ...previousSessions,
      [tabId]: { ...createDefaultSessionState(), chatState: 'thinking', agentStreamRevision: 1 },
    } })
    const view = render(<App />)
    try {
      await waitFor(() => expect(useIdlePowerStore.getState().snapshot).toEqual(nativeState))
      expect(listen).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('region', { name: 'After-task system action' })).not.toBeInTheDocument()

      act(() => settleAgentRunSession(tabId, 1))
      expect(useChatStore.getState().sessions[tabId]?.chatState).toBe('idle')
      expect(useIdlePowerStore.getState().snapshot).toEqual(nativeState)
      expect(screen.queryByRole('button', { name: 'Cancel idle action' })).not.toBeInTheDocument()
      expect(readState).toHaveBeenCalledTimes(1)
      expect(configure).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()

      // This mocked bridge proves only renderer ownership. The real HTTP
      // server/controller regression proves background work and approvals
      // prevent eligibility. A stale renderer marker cannot override the host.
      act(() => useChatStore.setState({ sessions: {
        ...useChatStore.getState().sessions,
        [tabId]: { ...useChatStore.getState().sessions[tabId]!, chatState: 'thinking' },
      } }))
      nativeState = { ...nativeState, countdown: { id: 'host-authorized', action: 'sleep', deadline: Date.now() + 60_000 } }
      act(() => listener?.(nativeState))
      expect(screen.getByText('Sleep in 60 seconds.')).toBeInTheDocument()
      expect(useChatStore.getState().sessions[tabId]?.chatState).toBe('thinking')
      expect(configure).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      useChatStore.setState({ sessions: previousSessions })
    }
  })

  it.each([
    ['requested', 'Last action requested: Sleep.'],
    ['accepted', 'System accepted the last request: Sleep. Completion is not confirmed.'],
    ['failed', 'Last action request failed: Sleep.'],
  ] as const)('describes a %s record without claiming the operating system completed it', (result, text) => {
    useIdlePowerStore.setState({ snapshot: { ...nativeState, countdown: null,
      lastAction: { action: 'sleep', requestedAt: Date.now(), result } } })
    render(<IdlePowerStatus />)
    expect(screen.getByText(text)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText(text)).not.toBeInTheDocument()
  })

  it('cleans up a subscription that finishes registering after App unmounts', async () => {
    let finishListening!: (stop: () => void) => void
    listen.mockImplementationOnce(() => new Promise<() => void>(resolve => { finishListening = resolve }))
    const { unmount } = render(<App />)
    unmount()
    await act(async () => { finishListening(unlisten) })
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('does not show native status or start its subscription in a browser', () => {
    window.desktopHost = { ...window.desktopHost!, isDesktop: false, kind: 'browser' }
    render(<App />)
    expect(screen.queryByText(/Sleep in/)).not.toBeInTheDocument()
    expect(listen).not.toHaveBeenCalled()
  })
})
