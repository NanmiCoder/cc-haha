import { create } from 'zustand'
import { getDesktopHost } from '../lib/desktopHost'
import { PREVENT_SLEEP_STORAGE_KEY, readPreventSleepPreference } from '../lib/preventSleepPreference'

type PowerSettingsState = {
  preventSleepWhileRunning: boolean
  saving: boolean
  error: boolean
  restore: () => Promise<void>
  setPreventSleepWhileRunning: (enabled: boolean) => Promise<void>
}

export const usePowerSettingsStore = create<PowerSettingsState>((set, get) => {
  async function apply(enabled: boolean, persist: boolean): Promise<void> {
    if (get().saving) return
    const previous = get().preventSleepWhileRunning
    const host = getDesktopHost()
    set({ saving: true, error: false })
    try {
      await host.power.setPreventSleepWhileRunning(enabled)
      if (persist) {
        try {
          localStorage.setItem(PREVENT_SLEEP_STORAGE_KEY, enabled ? '1' : '0')
        } catch (error) {
          await host.power.setPreventSleepWhileRunning(previous)
          throw error
        }
      }
      set({ preventSleepWhileRunning: enabled })
    } catch (error) {
      set({ error: true })
      throw error
    } finally {
      set({ saving: false })
    }
  }

  return {
    preventSleepWhileRunning: readPreventSleepPreference(),
    saving: false,
    error: false,
    restore: () => apply(readPreventSleepPreference(), false),
    setPreventSleepWhileRunning: enabled => apply(enabled, true),
  }
})
