export const PREVENT_SLEEP_STORAGE_KEY = 'cc-haha-prevent-sleep-while-running'

export function readPreventSleepPreference(): boolean {
  try {
    return localStorage.getItem(PREVENT_SLEEP_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
