/** Installed @oai/sky targets/mac/errors.js, CodexComputerUseIPC-5. */
export const NATIVE_SERVER_ERROR_CODES = {
  senderProcessNotAuthenticated: -10000,
  couldNotGetRequestData: -10001,
  couldNotGetRequestTypeName: -10002,
  couldNotResolveRequestType: -10003,
  unhandledEvent: -10004,
  unknownError: -10005,
  appNotAllowed: -10006,
  runningApplicationNotFound: -10007,
  accessibilityError: -10008,
  permissionsNotGranted: -10009,
  invalidApp: -10010,
  noActiveSession: -10011,
  userStoppedSession: -10012,
  incompatibleClientVersion: -10013,
  permissionsPending: -10014,
  blockedURL: -10015,
  userIntervened: -10016,
  couldNotGetSenderPID: -10017,
  ambiguousApp: -10018,
  couldNotGetBootstrapPort: -10019,
  screenLocked: -10020,
} as const

/** Only mappings whose native throw sites establish the corresponding cause.
 * In particular app_denied includes failed identity proof, and stale_* differs
 * from a missing process; neither is guessed from the human-readable message.
 */
export const NATIVE_HELPER_ERROR_MAP = {
  not_trusted: 'permissionsNotGranted',
  screen_recording_denied: 'permissionsNotGranted',
  ax_failed: 'accessibilityError',
  process_gone: 'runningApplicationNotFound',
  target_not_running: 'runningApplicationNotFound',
  ambiguous_target: 'ambiguousApp',
  protocol_mismatch: 'incompatibleClientVersion',
  screen_locked: 'screenLocked',
  user_interference: 'userIntervened',
} as const satisfies Record<string, keyof typeof NATIVE_SERVER_ERROR_CODES>

export interface NativeErrorMetadata {
  name: 'Error' | 'TypeError' | 'SkyComputerUseError'
  message: string
  code?: number
  errorName?: string
  /** The helper discriminator is retained even when no official code is known. */
  nativeCode?: string
  request?: null
  requestType?: 'jsonRPC'
}

/** Internal only; the binder deliberately projects this metadata into JSON. */
export const NATIVE_ERROR = Symbol('computer-use-native-error')

/** A rejected command is never an infrastructure failure eligible for replay. */
export class NativeCommandError extends Error {
  readonly nativeCode?: string

  constructor(message: string, nativeCode?: string) {
    super(message)
    this.name = 'NativeCommandError'
    this.nativeCode = nativeCode
  }
}

export function toNativeErrorMetadata(error: unknown): NativeErrorMetadata {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof TypeError) return { name: 'TypeError', message }
  if (error instanceof NativeCommandError && error.nativeCode !== undefined) {
    const nativeCode = error.nativeCode
    const errorName = Object.hasOwn(NATIVE_HELPER_ERROR_MAP, nativeCode)
      ? NATIVE_HELPER_ERROR_MAP[nativeCode as keyof typeof NATIVE_HELPER_ERROR_MAP]
      : undefined
    if (errorName !== undefined) return {
      name: 'SkyComputerUseError', message, nativeCode,
      code: NATIVE_SERVER_ERROR_CODES[errorName], errorName,
      // The official native pipe wraps JSON-RPC errors with these values.
      request: null, requestType: 'jsonRPC',
    }
    return { name: 'Error', message, nativeCode }
  }
  return { name: 'Error', message }
}
