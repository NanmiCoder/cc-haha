import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '../lib/desktopHost/browserHost'
import { PREVENT_SLEEP_STORAGE_KEY } from '../lib/preventSleepPreference'
import { usePowerSettingsStore } from './powerSettingsStore'

const setEnabled = vi.fn(async (_enabled: boolean) => {})

describe('desktop power preference', () => {
  beforeEach(() => {
    localStorage.clear()
    setEnabled.mockReset().mockResolvedValue(undefined)
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true,
      power: { setPreventSleepWhileRunning: setEnabled } }
    usePowerSettingsStore.setState({ preventSleepWhileRunning: false, saving: false, error: false })
  })
  afterEach(() => { Reflect.deleteProperty(window, 'desktopHost'); vi.restoreAllMocks() })

  it('restores an old install as off and restores an opt-in after restart', async () => {
    await usePowerSettingsStore.getState().restore()
    expect(setEnabled).toHaveBeenLastCalledWith(false)
    localStorage.setItem(PREVENT_SLEEP_STORAGE_KEY, '1')
    await usePowerSettingsStore.getState().restore()
    expect(setEnabled).toHaveBeenLastCalledWith(true)
    expect(usePowerSettingsStore.getState().preventSleepWhileRunning).toBe(true)
  })

  it('saves both choices only after the native host accepts them', async () => {
    await usePowerSettingsStore.getState().setPreventSleepWhileRunning(true)
    expect(localStorage.getItem(PREVENT_SLEEP_STORAGE_KEY)).toBe('1')
    expect(usePowerSettingsStore.getState().preventSleepWhileRunning).toBe(true)
    await usePowerSettingsStore.getState().setPreventSleepWhileRunning(false)
    expect(setEnabled.mock.calls).toEqual([[true], [false]])
    expect(localStorage.getItem(PREVENT_SLEEP_STORAGE_KEY)).toBe('0')
  })

  it('retains the old choice and allows retry after native IPC fails', async () => {
    setEnabled.mockRejectedValueOnce(new Error('fixture IPC failure'))
    await expect(usePowerSettingsStore.getState().setPreventSleepWhileRunning(true)).rejects.toThrow()
    expect(usePowerSettingsStore.getState()).toMatchObject({ preventSleepWhileRunning: false, saving: false, error: true })
    expect(localStorage.getItem(PREVENT_SLEEP_STORAGE_KEY)).toBeNull()
    await usePowerSettingsStore.getState().setPreventSleepWhileRunning(true)
    expect(usePowerSettingsStore.getState()).toMatchObject({ preventSleepWhileRunning: true, error: false })
  })

  it('rolls back the native choice when local persistence fails', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('fixture full storage') })
    await expect(usePowerSettingsStore.getState().setPreventSleepWhileRunning(true)).rejects.toThrow('fixture full storage')
    expect(setEnabled.mock.calls).toEqual([[true], [false]])
    expect(usePowerSettingsStore.getState().preventSleepWhileRunning).toBe(false)
  })
})
