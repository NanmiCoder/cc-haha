import { createFallbackStorage } from './fallbackStorage.js'
import { libsecretStorage, secretToolAvailableSync } from './libsecretStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage } from './types.js'

/**
 * Get the appropriate secure storage implementation for the current platform.
 *
 *  - macOS → Keychain (via `security`) with plaintext fallback.
 *  - Linux → libsecret (via `secret-tool`) when available; otherwise plaintext.
 *  - Windows / other → plaintext only.
 */
export function getSecureStorage(): SecureStorage {
  if (process.platform === 'darwin') {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }

  if (process.platform === 'linux') {
    if (secretToolAvailableSync()) {
      return createFallbackStorage(libsecretStorage, plainTextStorage)
    }
  }

  return plainTextStorage
}
