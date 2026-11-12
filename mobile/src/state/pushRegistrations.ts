import { ApiError, type ApiClient } from '../core/client'
import type { Storage } from './storage'

type PushClient = Pick<ApiClient, 'host' | 'request'>
export type PushRegistrationInput = {
  platform: 'ios' | 'android'
  /** Absent for the computer's own APNs / FCM; only sent to computers that list it. */
  provider?: 'expo' | 'desktop'
  token: string
  hostId: string
  kind?: 'notification' | 'liveActivity'
  deviceToken?: string
  hostName?: string
  sessionId?: string
  activityId?: string
  name?: string
  preferences: { decisions: boolean; completed: boolean; errors: boolean }
  quietHours: { enabled: boolean; start: string; end: string }
  timeZone: string
  /** Tell the computer how to deliver to this phone (channels, time-sensitive notifications, lock screen activity filter); older desktop versions do not recognize it. */
  delivery?: PushDelivery
}
export type PushDelivery = {
  channels?: 'split'
  timeSensitive?: boolean
  liveActivity?: 'running' | 'decisions'
  showCommand?: boolean
}
export type PushRegistrationResult = {
  registered: boolean
  status: 'registered' | 'notConfigured'
  id?: string
}
export type PushRegistrationProofs = { version: 1; tokens: string[] }

/**
 * Delivery method attached at registration. Android only declares that channels are split (the caller must create the channels before passing
 * channelsReady); iOS includes time-sensitive notification and lock screen activity filter settings.
 */
export function buildDelivery(
  platform: 'ios' | 'android',
  options: {
    channelsReady?: boolean
    timeSensitive: boolean
    liveActivity: 'running' | 'decisions'
    liveActivityShowCommand: boolean
  }
): PushDelivery | undefined {
  if (platform === 'android')
    return options.channelsReady ? { channels: 'split' } : undefined
  return {
    timeSensitive: options.timeSensitive,
    liveActivity: options.liveActivity,
    showCommand: options.liveActivityShowCommand,
  }
}
export const pushProofKey = (hostId: string) => `cc-haha.push.${hostId}`

/** This record belongs in SecureStore, never the public host metadata or AsyncStorage. */
export function migratePushProofs(raw: string | null): PushRegistrationProofs {
  if (!raw) return { version: 1, tokens: [] }
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Notification registration credentials cannot be read; raw data kept')
  if (value.version !== undefined && value.version !== 0 && value.version !== 1)
    throw new Error('Notification registration is from a newer version; please upgrade first App')
  if (
    !Array.isArray(value.tokens) ||
    value.tokens.some(
      (token: unknown) =>
        typeof token !== 'string' || !token || token.length > 4096
    )
  )
    throw new Error('Notification registration credentials cannot be read; raw data kept')
  return { version: 1, tokens: [...new Set<string>(value.tokens)] }
}

const cancelled = () => new ApiError('Notification registration canceled', 0, 'ABORTED')
/** When removing a computer, spend at most this long asking it to unregister this phone's notifications. */
const REMOVE_REVOKE_BUDGET_MS = 3000

/** One queue per host drains accepted writes before removal. A durable token is saved
 * before PUT, so a restart, timeout or lost response cannot lose the revoke proof. */
export class PushRegistrationCoordinator {
  private queues = new Map<string, Promise<unknown>>()
  private blocked = new Set<string>()
  private removals = new Map<string, Promise<unknown>>()
  private localCleanup = new Map<string, Set<() => Promise<void>>>()
  constructor(
    private secrets: Storage,
    private options: { revokeBudgetMs?: number } = {}
  ) {}

  register(
    client: PushClient,
    input: PushRegistrationInput,
    signal?: AbortSignal
  ): Promise<PushRegistrationResult> {
    const hostId = client.host.id
    if (hostId !== input.hostId)
      return Promise.reject(new Error('Notification registration computer mismatch'))
    if (this.blocked.has(hostId) || signal?.aborted)
      return Promise.reject(cancelled())
    return this.serial(hostId, async () => {
      const check = () => {
        if (this.blocked.has(hostId) || signal?.aborted) throw cancelled()
      }
      check()
      const deviceToken =
        input.kind === 'liveActivity' ? input.deviceToken : input.token
      if (!deviceToken) throw new Error('Lock screen activity is missing the device notification credential')
      const raw = await this.secrets.getItem(pushProofKey(hostId))
      const previous = migratePushProofs(raw)
      check()
      const next = JSON.stringify({
        version: 1,
        tokens: [...new Set([...previous.tokens, deviceToken])],
      })
      const changed = raw !== next
      if (changed) await this.secrets.setItem(pushProofKey(hostId), next)
      try {
        check()
      } catch (error) {
        if (changed) {
          if (raw === null) await this.secrets.removeItem(pushProofKey(hostId))
          else await this.secrets.setItem(pushProofKey(hostId), raw)
        }
        throw error
      }
      // Logical cancellation must not hide a successful write. Let this bounded PUT
      // settle, then compensate before the next registration/removal enters the queue.
      const put = (body: PushRegistrationInput) =>
        client.request<PushRegistrationResult>('/api/sessions/mobile-push', {
          method: 'PUT',
          body,
          timeoutMs: 8000,
        })
      let result: PushRegistrationResult
      try {
        result = await put(input)
      } catch (error) {
        // Older desktop versions strictly validate registration fields and return 400 when they see delivery: retry once without it.
        if (!(input.delivery && error instanceof ApiError && error.status === 400))
          throw error
        const { delivery: _delivery, ...legacy } = input
        result = await put(legacy)
      }
      if (result.registered && !result.id)
        throw new ApiError('The server did not return a notification registration ID', 0, 'INVALID_RESPONSE')
      if (signal?.aborted || this.blocked.has(hostId)) {
        if (result.registered && result.id)
          await this.deleteOne(client, result.id, input.token)
        throw cancelled()
      }
      return result
    })
  }

  unregister(client: PushClient, id: string, token: string) {
    return this.serial(client.host.id, () => this.deleteOne(client, id, token))
  }

  /** Also used after OS notification permission is revoked. */
  clearRegistrations(client: PushClient) {
    return this.serial(client.host.id, async () => {
      await this.revokeAll(client)
      await this.secrets.removeItem(pushProofKey(client.host.id))
    })
  }

  onRemoveHost(hostId: string, cleanup: () => Promise<void>) {
    const callbacks = this.localCleanup.get(hostId) ?? new Set()
    callbacks.add(cleanup)
    this.localCleanup.set(hostId, callbacks)
    return () => {
      callbacks.delete(cleanup)
      if (!callbacks.size) this.localCleanup.delete(hostId)
    }
  }

  /**
   * Forgets a computer on this phone. Nothing on the computer can veto it: people remove a
   * computer when it is asleep, gone or on another network, so asking it to drop this phone's
   * registrations is tried once, within a short budget, and never required. A registration it
   * keeps expires on its own, or when the pairing is revoked there. Only a local failure
   * rejects, and then the computer and its credential stay.
   */
  removeHost<T>(
    hostId: string,
    client: PushClient | null,
    removeLocal: () => Promise<T>
  ): Promise<T> {
    const pending = this.removals.get(hostId)
    if (pending) return pending as Promise<T>
    this.blocked.add(hostId)
    const result = (async () => {
      await this.serial(hostId, async () => {
        if (client && client.host.id !== hostId)
          throw new Error('Notification unregistration computer mismatch')
        const proof = migratePushProofs(
          await this.secrets.getItem(pushProofKey(hostId))
        )
        if (client && proof.tokens.length)
          await this.revokeWithinBudget(client, proof.tokens)
      })
      // These callbacks only end the native UI. When the computer answered, the
      // collection DELETE already retired every associated Live Activity,
      // including process-recovered ones.
      for (const cleanup of this.localCleanup.get(hostId) ?? []) await cleanup()
      return this.serial(hostId, async () => {
        await this.secrets.removeItem(pushProofKey(hostId))
        return removeLocal()
      })
    })()
      .catch((error) => {
        this.blocked.delete(hostId)
        throw new Error(
          `Removal did not finish; the computer and credentials were kept. ${error instanceof Error ? error.message : 'Please retry later'}`
        )
      })
      .finally(() => {
        this.removals.delete(hostId)
      })
    this.removals.set(hostId, result)
    return result
  }

  private async revokeWithinBudget(client: PushClient, tokens: string[]) {
    const budget = new AbortController()
    const timer = setTimeout(
      () => budget.abort(),
      this.options.revokeBudgetMs ?? REMOVE_REVOKE_BUDGET_MS
    )
    try {
      await this.revokeTokens(client, tokens, budget.signal)
    } catch {
      // Whatever the computer answered, or didn't, is not the user's problem here.
    } finally {
      clearTimeout(timer)
    }
  }

  private async revokeAll(client: PushClient) {
    const proof = migratePushProofs(
      await this.secrets.getItem(pushProofKey(client.host.id))
    )
    await this.revokeTokens(client, proof.tokens)
  }
  private async revokeTokens(
    client: PushClient,
    tokens: string[],
    signal?: AbortSignal
  ) {
    for (const token of tokens) {
      try {
        await client.request<{ removed: number }>('/api/sessions/mobile-push', {
          method: 'DELETE',
          body: { token, hostId: client.host.id },
          timeoutMs: 6000,
          signal,
        })
      } catch (error) {
        // The computer no longer recognizes this credential (old entry after re-pairing, computer cleared authorization): remote revocation cannot succeed, 
        // so treat it as revoked, otherwise the registration would stay forever through repeated retries.
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return
        throw error
      }
    }
  }
  private async deleteOne(client: PushClient, id: string, token: string) {
    try {
      await client.request(
        `/api/sessions/mobile-push/${encodeURIComponent(id)}`,
        { method: 'DELETE', body: { token }, timeoutMs: 6000 }
      )
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error
    }
  }
  private serial<T>(hostId: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(hostId) ?? Promise.resolve()).then(task)
    const settled = result.catch(() => {})
    this.queues.set(hostId, settled)
    void settled.then(() => {
      if (this.queues.get(hostId) === settled) this.queues.delete(hostId)
    })
    return result
  }
}
