export type RawOsPermissions = {
  accessibility: boolean
  screenRecording: boolean | null
}

export type NormalizedOsPermissions = {
  granted: boolean
  accessibility: boolean
  screenRecording: boolean
}

/**
 * macOS Screen Recording passive probes can come back "unknown" for helper
 * child processes even when the app bundle is already authorized. Treat that
 * state as non-blocking and let the actual capture path remain the final
 * source of truth.
 */
export function normalizeOsPermissions(perms: RawOsPermissions): NormalizedOsPermissions {
  const screenRecording = perms.screenRecording !== false
  return {
    granted: perms.accessibility && screenRecording,
    accessibility: perms.accessibility,
    screenRecording,
  }
}
