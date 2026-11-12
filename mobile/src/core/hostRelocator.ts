import { ApiError, type ApiClient } from './client'
import type { HostUrlUpdate } from './notifications'
import { parseLocatorHints, verifyHostUrlPush, type LocatorHints } from './relocate'
import type { Host } from './types'

/** When the same computer is unreachable, look for a new address on the LAN at most this often. */
export const LOCATE_COOLDOWN_MS = 30_000
/** How often to re-request LAN hints (port, IP) from the computer. */
export const HINTS_MAX_AGE_MS = 6 * 3600_000
/** How long to wait before asking for hints again after a failure (not an old computer). */
export const HINTS_RETRY_MS = 10 * 60_000

export type LocatorRecord = LocatorHints & { updatedAt: number }
export type LocatorStore = {
  get(id: string): Promise<LocatorRecord | null>
  set(id: string, record: LocatorRecord): Promise<void>
  retain(ids: readonly string[]): Promise<void>
}
/** App computer registry (attached by AppContext). */
export type RelocationTarget = {
  host(id: string): Host | undefined
  credential(id: string): Promise<string | null>
  relocate(id: string, url: string): Promise<void>
}
type LocatorClient = Pick<ApiClient, 'host' | 'get'>

/** Cloudflare The request was received but could not reach the computer: tunnel gone (530) or no response from the computer (502–504). */
const GATEWAY_STATUSES = new Set([502, 503, 504, 530])
/** Unreachable at the network level (no response, timeout, DNS, disconnect, gateway error); auth and pairing failures do not count. */
export function isUnreachable(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT' || GATEWAY_STATUSES.has(error.status))
  )
}

/**
 * Find a remote computer again when its public address changes; the only place in the app (see createApiClient in state/api.ts: 
 * every request to a remote computer reports here when it ends): 
 * - Request succeeded: if there are no hints or they are older than 6 hours, ask the computer for LAN hints and store them; 
 * - Unreachable due to network: at most once per 30 seconds per computer, ask for the new address on the LAN using the hints, 
 *   and if the signature is valid and differs from the registry, update it — clients everywhere switch to the new address and retry.
 */
export class HostRelocator {
  #target?: RelocationTarget
  #hintsDue = new Map<string, number>()
  #refreshing = new Set<string>()
  #locatedAt = new Map<string, number>()
  #locating = new Set<string>()
  #now: () => number

  constructor(
    private deps: {
      hints: LocatorStore
      locate(hints: LocatorHints, credential: string): Promise<string | null>
      now?: () => number
    }
  ) {
    this.#now = deps.now ?? Date.now
  }

  attach(target: RelocationTarget) {
    this.#target = target
    return () => {
      if (this.#target === target) this.#target = undefined
    }
  }

  /** A request ended: `null` means success, otherwise its error. */
  settled(client: LocatorClient, error: unknown) {
    if (error === null) void this.contacted(client)
    else if (isUnreachable(error)) void this.unreachable(client.host)
  }

  /** Keep only computers still in the registry: forget deleted computers along with their hints. */
  retain(ids: readonly string[]) {
    const kept = new Set(ids)
    for (const map of [this.#hintsDue, this.#locatedAt])
      for (const id of [...map.keys()]) if (!kept.has(id)) map.delete(id)
    return this.deps.hints.retain(ids)
  }

  /** The requesting client still points to this computer's current address in the registry; old clients from before an address change do not count. */
  #current(host: Host) {
    const current = this.#target?.host(host.id)
    return current && current.auth === 'remote' && !current.page && current.url === host.url ? current : undefined
  }

  async contacted(client: LocatorClient) {
    const id = client.host.id
    if (!this.#current(client.host) || this.#refreshing.has(id)) return
    const due = this.#hintsDue.get(id)
    if (due !== undefined && this.#now() < due) return
    this.#refreshing.add(id)
    try {
      if (due === undefined) {
        // First time this run: do not ask if stored hints are still fresh.
        const stored = await this.deps.hints.get(id)
        const now = this.#now()
        if (stored && stored.updatedAt <= now && now - stored.updatedAt < HINTS_MAX_AGE_MS) {
          this.#hintsDue.set(id, stored.updatedAt + HINTS_MAX_AGE_MS)
          return
        }
      }
      const hints = parseLocatorHints(await client.get<unknown>('/api/public-access/locator', { timeoutMs: 6000 }))
      if (!hints) {
        this.#hintsDue.set(id, this.#now() + HINTS_RETRY_MS)
        return
      }
      if (!this.#target?.host(id)) return
      await this.deps.hints.set(id, { ...hints, updatedAt: this.#now() })
      this.#hintsDue.set(id, this.#now() + HINTS_MAX_AGE_MS)
    } catch (error) {
      // Old computers have no such endpoint: do not ask again during this run.
      this.#hintsDue.set(
        id,
        error instanceof ApiError && error.status === 404 ? Infinity : this.#now() + HINTS_RETRY_MS
      )
    } finally {
      this.#refreshing.delete(id)
    }
  }

  /** Returns whether the registered address was changed. */
  async unreachable(host: Host): Promise<boolean> {
    const id = host.id
    if (!this.#current(host) || this.#locating.has(id)) return false
    const last = this.#locatedAt.get(id)
    const now = this.#now()
    if (last !== undefined && now - last < LOCATE_COOLDOWN_MS) return false
    this.#locatedAt.set(id, now)
    this.#locating.add(id)
    try {
      const record = await this.deps.hints.get(id)
      const target = this.#target
      if (!record?.addresses.length || !target) return false
      const credential = await target.credential(id)
      if (!credential) return false
      const url = await this.deps.locate(record, credential)
      const current = this.#target?.host(id)
      if (!url || !current || current.auth !== 'remote' || current.url === url) return false
      await this.#target!.relocate(id, url)
      return true
    } catch {
      return false
    } finally {
      this.#locating.delete(id)
    }
  }
}

/**
 * New address pushed by the computer: verify the signature with this computer's stored credential. relocated = registry changed; 
 * current=signature valid, address unchanged; ignored = unknown computer, no credential or bad signature.
 */
export async function applyHostUrlUpdate(
  update: HostUrlUpdate,
  target: { hosts: readonly Host[]; credential(id: string): Promise<string | null>; relocate(id: string, url: string): Promise<void> }
): Promise<'relocated' | 'current' | 'ignored'> {
  const host = target.hosts.find((item) => item.id === update.hostId)
  if (!host || host.auth !== 'remote' || host.page) return 'ignored'
  let credential: string | null
  try {
    credential = await target.credential(host.id)
  } catch {
    return 'ignored'
  }
  const url = credential ? verifyHostUrlPush(credential, update) : null
  if (!url) return 'ignored'
  if (url === host.url) return 'current'
  await target.relocate(host.id, url)
  return 'relocated'
}
