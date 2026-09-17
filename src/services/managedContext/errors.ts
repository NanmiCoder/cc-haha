/**
 * Structured errors for the managed-context staging path (M7).
 * The codes are part of the contract; callers (and the WS bridge in M7-B)
 * switch on `code`, never on the message.
 */

export type ManagedContextErrorCode =
  /** includePasswords=true while the disclosure path is not shipped (M8). */
  | 'SECRET_DISCLOSURE_NOT_READY'
  /** No reachable vault/credential store in this process. */
  | 'SECRET_VAULT_UNAVAILABLE'
  /** A selected entity (or a dependency of one) is not in the staged snapshot. */
  | 'CONTEXT_RESOURCE_MISSING'
  /** Entity revision drifted between selection and staging. */
  | 'CONTEXT_REVISION_CHANGED'
  /** Selection is internally inconsistent (schema version, credentialRefs, ...). */
  | 'INVALID_CONTEXT_SELECTION'
  /** Secret material or a forbidden key name was found in the payload. */
  | 'CONTEXT_SECRET_DETECTED'
  /** An absolute local path was found in the public manifest. */
  | 'CONTEXT_ABSOLUTE_PATH_DETECTED'
  /** The composed context is larger than the 64 KiB prompt-context limit. */
  | 'CONTEXT_TOO_LARGE'

export class ManagedContextError extends Error {
  readonly code: ManagedContextErrorCode
  readonly details?: Record<string, unknown>

  constructor(
    code: ManagedContextErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ManagedContextError'
    this.code = code
    this.details = details
  }
}
