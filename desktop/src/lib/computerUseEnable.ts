import type { ComputerUseStatus } from '@/api/computerUse'

/**
 * What turning Computer Use on writes, wherever the user does it. The consent
 * dialog in front of it is the one authorization boundary: confirming covers
 * every app, so the grants it implies are switched on together.
 */
export const COMPUTER_USE_ENABLE_REQUEST = {
  enabled: true,
  grantFlags: {
    clipboardRead: true,
    clipboardWrite: true,
    systemKeyCombos: true,
  },
} as const

/** The native macOS engine still needs the OS permission card after consent. */
export function needsComputerUsePermissionCard(status: ComputerUseStatus | null | undefined): boolean {
  return status?.engine === 'macos-native'
    && (status.permissions.accessibility === false || status.permissions.screenRecording === false)
}
