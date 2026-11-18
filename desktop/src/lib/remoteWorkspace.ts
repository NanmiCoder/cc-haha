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
  /**
   * The remote server's process credential, as deployed. Sent on every call so
   * the remote classifies this renderer by its strongest credential — origin
   * and locality stay irrelevant, exactly as for the local sidecar.
   */
  token?: string
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
  token?: string
  enabled: boolean
  connectedAt: string | null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * The deploy helper mints tokens as base64url; anything else is dropped rather
 * than sent as a credential.
 */
function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{16,}$/.test(value)
}

/** A stored or pasted token this build will actually send, or `null`. */
export function normalizeRemoteWorkspaceToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim()
  return isSafeToken(trimmed) ? trimmed : null
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
    ...(isSafeToken(value.token) ? { token: value.token } : {}),
    enabled: value.enabled,
    connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : null,
  }
}

export function serializeRemoteWorkspaceProfile(profile: RemoteWorkspaceProfile): string {
  const stored: StoredRemoteWorkspace = {
    version: REMOTE_WORKSPACE_STORAGE_VERSION,
    url: profile.url,
    sshHost: profile.sshHost,
    ...(isSafeToken(profile.token) ? { token: profile.token } : {}),
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

/** One machine the user has connected to, remembered so reconnecting is a click. */
export type RemoteWorkspaceMachine = {
  url: string
  sshHost: string
  token?: string
  lastUsedAt: string
}

export const REMOTE_WORKSPACE_HISTORY_KEY = 'cc-haha-remote-workspace-history'
export const REMOTE_WORKSPACE_HISTORY_LIMIT = 5

type StoredRemoteWorkspaceHistory = {
  version: number
  machines: Array<{ url: string; sshHost: string; token?: string; lastUsedAt: string }>
}

function parseRemoteWorkspaceMachine(value: unknown): RemoteWorkspaceMachine | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const machine = value as Partial<StoredRemoteWorkspaceHistory['machines'][number]>
  if (!isNonEmptyString(machine.url) || !isNonEmptyString(machine.sshHost)) return null
  if (!isNonEmptyString(machine.lastUsedAt)) return null
  return {
    url: machine.url,
    sshHost: machine.sshHost,
    ...(isSafeToken(machine.token) ? { token: machine.token } : {}),
    lastUsedAt: machine.lastUsedAt,
  }
}

export function parseRemoteWorkspaceHistory(raw: string | null): RemoteWorkspaceMachine[] {
  if (!raw) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const value = parsed as Partial<StoredRemoteWorkspaceHistory>
  if (value.version !== REMOTE_WORKSPACE_STORAGE_VERSION) return []
  if (!Array.isArray(value.machines)) return []

  const seen = new Set<string>()
  const machines: RemoteWorkspaceMachine[] = []
  for (const candidate of value.machines) {
    const machine = parseRemoteWorkspaceMachine(candidate)
    if (!machine || seen.has(machine.url)) continue
    seen.add(machine.url)
    machines.push(machine)
  }
  return machines
}

/** How many rows the stored history carries, including rows this build rejects. */
export function countRemoteWorkspaceHistoryEntries(raw: string | null): number {
  if (!raw) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 0
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0
  const machines = (parsed as Partial<StoredRemoteWorkspaceHistory>).machines
  return Array.isArray(machines) ? machines.length : 0
}

export function readRemoteWorkspaceHistory(): RemoteWorkspaceMachine[] {
  if (typeof window === 'undefined') return []

  try {
    return parseRemoteWorkspaceHistory(window.localStorage.getItem(REMOTE_WORKSPACE_HISTORY_KEY))
  } catch {
    return []
  }
}

/** Add or refresh a machine, newest first, keeping only the most recent few. */
export function rememberRemoteWorkspaceMachine(
  machine: { url: string; sshHost: string; token?: string },
  connectedAt = new Date().toISOString(),
): void {
  const machines = readRemoteWorkspaceHistory().filter((entry) => entry.url !== machine.url)
  machines.unshift({ ...machine, lastUsedAt: connectedAt })
  const kept = machines.slice(0, REMOTE_WORKSPACE_HISTORY_LIMIT)
  try {
    window.localStorage.setItem(REMOTE_WORKSPACE_HISTORY_KEY, JSON.stringify({
      version: REMOTE_WORKSPACE_STORAGE_VERSION,
      machines: kept.map((entry) => ({
        url: entry.url,
        sshHost: entry.sshHost,
        ...(isSafeToken(entry.token) ? { token: entry.token } : {}),
        lastUsedAt: entry.lastUsedAt,
      })),
    }))
  } catch {
    // Storage restrictions must not break a connection that already works.
  }
}

export function forgetRemoteWorkspaceMachine(url: string): void {
  try {
    window.localStorage.setItem(REMOTE_WORKSPACE_HISTORY_KEY, JSON.stringify({
      version: REMOTE_WORKSPACE_STORAGE_VERSION,
      machines: readRemoteWorkspaceHistory().filter((entry) => entry.url !== url),
    }))
  } catch {
    // Ignore storage failures.
  }
}
