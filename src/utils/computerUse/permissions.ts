export type RawOsPermissions = {
  accessibility: boolean | null
  screenRecording: boolean | null
}

export type NormalizedOsPermissions = {
  granted: boolean
  accessibility: boolean
  screenRecording: boolean
}

/**
 * macOS permission passive probes can come back "unknown" for helper
 * child processes even when the app bundle is already authorized. Treat that
 * state as non-blocking and let the actual action attempt remain the final
 * source of truth.
 *
 * This applies to both Accessibility and Screen Recording: when running as a
 * child process of the desktop app, AXIsProcessTrusted() and
 * CGPreflightScreenCaptureAccess() may check the venv Python interpreter
 * rather than the app bundle, causing false negatives.
 */
export function normalizeOsPermissions(perms: RawOsPermissions): NormalizedOsPermissions {
  const accessibility = perms.accessibility !== false
  const screenRecording = perms.screenRecording !== false
  return {
    granted: accessibility && screenRecording,
    accessibility,
    screenRecording,
  }
}
