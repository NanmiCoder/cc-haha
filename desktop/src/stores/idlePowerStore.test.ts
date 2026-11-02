import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { DEFAULT_IDLE_POWER_SETTINGS, type IdlePowerState } from '@/lib/idlePower'
import { useIdlePowerStore } from './idlePowerStore'

function fixture(overrides: Partial<IdlePowerState> = {}): IdlePowerState {
  return {
    settings: { ...DEFAULT_IDLE_POWER_SETTINGS },
    capabilities: { lock: true, sleep: true, hibernate: false, shutdown: true },
    countdown: null,
    lastAction: null,
    notice: null,
    ...overrides,
  }
}

describe('idle power host state', () => {
  let nativeState: IdlePowerState
  let listener: ((state: IdlePowerState) => void) | undefined
  const getState = vi.fn()
  const configure = vi.fn()
  const cancel = vi.fn()
  const unlisten = vi.fn()
  const listen = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    nativeState = fixture()
    listener = undefined
    getState.mockImplementation(async () => nativeState)
    configure.mockImplementation(async settings => (nativeState = { ...nativeState, settings }))
    cancel.mockImplementation(async () => { nativeState = { ...nativeState, countdown: null, notice: 'cancelled' } })
    listen.mockImplementation(async handler => { listener = handler; return unlisten })
    window.desktopHost = {
      ...browserHost, kind: 'electron', isDesktop: true,
      power: { ...browserHost.power, getIdleActionState: getState, configureIdleAction: configure,
        cancelIdleAction: cancel, onIdleActionState: listen },
    }
    useIdlePowerStore.setState(useIdlePowerStore.getInitialState(), true)
  })
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
    vi.restoreAllMocks()
  })

  it('loads the native preference after a renderer restart without writing localStorage', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    expect(useIdlePowerStore.getState().snapshot).toBeNull()
    await useIdlePowerStore.getState().refresh()
    expect(useIdlePowerStore.getState().snapshot?.settings).toEqual(DEFAULT_IDLE_POWER_SETTINGS)
    nativeState = fixture({ settings: { action: 'sleep', scope: 'scheduled', countdownSeconds: 300 } })
    useIdlePowerStore.setState(useIdlePowerStore.getInitialState(), true)
    await useIdlePowerStore.getState().refresh()
    expect(useIdlePowerStore.getState().snapshot).toEqual(nativeState)
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps the confirmed setting after a failed save and allows retry', async () => {
    await useIdlePowerStore.getState().refresh()
    const settings = { action: 'lock', scope: 'any', countdownSeconds: 60 } as const
    configure.mockRejectedValueOnce(new Error('fixture native write failed'))
    await expect(useIdlePowerStore.getState().configure(settings)).rejects.toThrow('fixture native write failed')
    expect(useIdlePowerStore.getState()).toMatchObject({ saving: false, error: 'save', snapshot: { settings: DEFAULT_IDLE_POWER_SETTINGS } })
    await useIdlePowerStore.getState().configure(settings)
    expect(configure).toHaveBeenLastCalledWith(settings)
    expect(useIdlePowerStore.getState()).toMatchObject({ error: null, snapshot: { settings } })
  })

  it('refreshes the countdown after native cancellation and keeps it visible if cancellation fails', async () => {
    nativeState = fixture({ countdown: { id: 'countdown-1', action: 'sleep', deadline: Date.now() + 60_000 } })
    await useIdlePowerStore.getState().refresh()
    cancel.mockRejectedValueOnce(new Error('fixture IPC failed'))
    await expect(useIdlePowerStore.getState().cancel()).rejects.toThrow('fixture IPC failed')
    expect(useIdlePowerStore.getState()).toMatchObject({ cancelling: false, error: 'cancel', snapshot: { countdown: nativeState.countdown } })
    await useIdlePowerStore.getState().cancel()
    expect(useIdlePowerStore.getState()).toMatchObject({ error: null, snapshot: { countdown: null, notice: 'cancelled' } })
    expect(getState).toHaveBeenCalledTimes(2)
  })

  it('subscribes before loading and never revives a cancelled countdown from a stale reply', async () => {
    const staleState = fixture({ countdown: { id: 'old', action: 'shutdown', deadline: Date.now() + 60_000 } })
    let resolveSnapshot!: (state: IdlePowerState) => void
    getState.mockImplementationOnce(() => new Promise<IdlePowerState>(resolve => { resolveSnapshot = resolve }))
    const starting = useIdlePowerStore.getState().start()
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(1))
    expect(listen.mock.invocationCallOrder[0]).toBeLessThan(getState.mock.invocationCallOrder[0]!)
    const cancelledState = fixture({ notice: 'new-work' })
    listener?.(cancelledState)
    resolveSnapshot(staleState)
    const stop = await starting
    expect(useIdlePowerStore.getState()).toMatchObject({ loading: false, snapshot: cancelledState })
    stop()
    listener?.(staleState)
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(useIdlePowerStore.getState().snapshot).toEqual(cancelledState)
  })

  it('surfaces refresh and subscription failures without claiming native state is current', async () => {
    getState.mockRejectedValueOnce(new Error('fixture offline'))
    await expect(useIdlePowerStore.getState().refresh()).rejects.toThrow('fixture offline')
    expect(useIdlePowerStore.getState()).toMatchObject({ snapshot: null, loading: false, error: 'load' })
    listen.mockRejectedValueOnce(new Error('fixture event bridge unavailable'))
    await expect(useIdlePowerStore.getState().start()).rejects.toThrow('fixture event bridge unavailable')
    expect(useIdlePowerStore.getState().error).toBe('load')
  })

  it('does not read, subscribe, configure, or cancel native power from a browser', async () => {
    window.desktopHost = { ...window.desktopHost!, isDesktop: false, kind: 'browser' }
    const stop = await useIdlePowerStore.getState().start()
    await useIdlePowerStore.getState().refresh()
    await useIdlePowerStore.getState().configure(DEFAULT_IDLE_POWER_SETTINGS)
    await useIdlePowerStore.getState().cancel()
    stop()
    expect(getState).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
    expect(configure).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })
})
