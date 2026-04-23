/**
 * No-op replacement. The Python bridge does not support global Escape hotkey
 * via CGEventTap. The original implementation required native Swift module
 * for CGEventTap-based system-wide key interception.
 */
export function registerEscHotkey(_onEscape: () => void): boolean {
  return false
}

export function unregisterEscHotkey(): void {}

export function notifyExpectedEscape(): void {}
