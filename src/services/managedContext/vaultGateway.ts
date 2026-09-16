/**
 * Server-side secret-material boundary for managed context.
 *
 * The only credential vault in this repository lives in the Electron main
 * process (`desktop/electron/services/managedResources/.../credentialVault.ts`).
 * The sidecar has no reachable vault in this version, and M7 must not reveal
 * secrets at all: `includePasswords: true` is rejected with
 * `SECRET_DISCLOSURE_NOT_READY` *before* any gateway call. This module makes
 * the "no reachable vault" case explicit and testable instead of inventing a
 * second credential store.
 *
 * M8 is the stage that turns the disclosure path on; until then every
 * server-side gateway is `unavailable` and `reveal()` throws.
 */

import { ManagedContextError } from './errors.js'

export type VaultAvailability = 'available' | 'unavailable'

export interface SecretRevealGateway {
  /** Whether a decrypt/reveal path exists in this process at all. */
  availability(): VaultAvailability
  /** Reveal one credential; must throw when the vault is unavailable. */
  reveal(credentialId: string): string
}

/** The gateway the sidecar actually has today: no vault, no decrypt path. */
export function createUnreachableVaultGateway(): SecretRevealGateway {
  return {
    availability: () => 'unavailable',
    reveal(credentialId: string): string {
      throw new ManagedContextError(
        'SECRET_VAULT_UNAVAILABLE',
        'No credential vault is reachable from the server process in this version',
        { credentialId },
      )
    },
  }
}
