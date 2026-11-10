/**
 * The persisted "run my workspace on another machine" choice.
 *
 * The desktop renderer is a thin client over one cc-haha server: that server
 * owns each session's working directory, spawns the agent, and executes every
 * tool — file read/write/edit, Glob, Grep, Bash — and every permission check.
 * So pointing the renderer's single base URL at a server running elsewhere
 * moves the whole workspace there. This module owns only the persisted shape of
 * that choice; `desktopRuntime` applies it and enforces how it may be reached.
 *
 * The expected setup is an `ssh -L` tunnel, so the stored URL is the forwarded
 * loopback port on this machine, not the remote's address.
 */

export type RemoteWorkspaceProfile = {
  /** Base URL of the remote server, as forwarded to this machine. */
  url: string
  /** SSH host alias the tunnel forwards to, kept so the UI can name the machine. */
  sshHost: string
  /** A disabled profile is remembered but not applied at startup. */
  enabled: boolean
  connectedAt: string | null
}

export const REMOTE_WORKSPACE_STORAGE_KEY = 'cc-haha-remote-workspace'
export const REMOTE_WORKSPACE_STORAGE_VERSION = 1

type StoredRemoteWorkspace = {
  version: number
  url: string
  sshHost: string
  enabled: boolean
  connectedAt: string | null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Read a stored profile back as the shape this build understands, or `null`.
 *
 * Anything this build cannot vouch for is discarded rather than partially
 * applied: a half-read profile would put the renderer on one machine and its
 * sessions on another. A `version` this build does not know is left alone, the
 * same way the workspace hydrator treats a newer schema — deleting it would
 * let one downgrade silently forget a machine the newer build still uses.
 */
export function parseRemoteWorkspaceProfile(raw: string | null): RemoteWorkspaceProfile | null {
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = parsed as Partial<StoredRemoteWorkspace>
  if (value.version !== REMOTE_WORKSPACE_STORAGE_VERSION) return null
  if (!isNonEmptyString(value.url) || !isNonEmptyString(value.sshHost)) return null
  if (typeof value.enabled !== 'boolean') return null

  return {
    url: value.url,
    sshHost: value.sshHost,
    enabled: value.enabled,
    connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : null,
  }
}

export function serializeRemoteWorkspaceProfile(profile: RemoteWorkspaceProfile): string {
  const stored: StoredRemoteWorkspace = {
    version: REMOTE_WORKSPACE_STORAGE_VERSION,
    url: profile.url,
    sshHost: profile.sshHost,
    enabled: profile.enabled,
    connectedAt: profile.connectedAt,
  }
  return JSON.stringify(stored)
}

export function readRemoteWorkspace(): RemoteWorkspaceProfile | null {
  if (typeof window === 'undefined') return null

  try {
    return parseRemoteWorkspaceProfile(window.localStorage.getItem(REMOTE_WORKSPACE_STORAGE_KEY))
  } catch {
    return null
  }
}

export function writeRemoteWorkspace(profile: RemoteWorkspaceProfile): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(REMOTE_WORKSPACE_STORAGE_KEY, serializeRemoteWorkspaceProfile(profile))
  } catch {
    // Storage restrictions must not break a connection that already works.
  }
}

export function clearRemoteWorkspace(): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(REMOTE_WORKSPACE_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}

/** The profile to apply at startup, or `null` when the runtime stays local. */
export function getEnabledRemoteWorkspace(): RemoteWorkspaceProfile | null {
  const profile = readRemoteWorkspace()
  return profile?.enabled ? profile : null
}
