import { ApiError, type ApiClient } from '../core/client'
import type { Storage } from './storage'

type PushClient = Pick<ApiClient, 'host' | 'request'>
export type PushRegistrationInput = {
  platform: 'ios' | 'android'
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
}
export type PushRegistrationResult = {
  registered: boolean
  status: 'registered' | 'notConfigured'
  id?: string
}
export type PushRegistrationProofs = { version: 1; tokens: string[] }
export const pushProofKey = (hostId: string) => `cc-haha.push.${hostId}`

/** This record belongs in SecureStore, never the public host metadata or AsyncStorage. */
export function migratePushProofs(raw: string | null): PushRegistrationProofs {
  if (!raw) return { version: 1, tokens: [] }
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('通知登记凭据无法读取，原始数据已保留')
  if (value.version !== undefined && value.version !== 0 && value.version !== 1)
    throw new Error('通知登记来自更新版本，请先升级 App')
  if (
    !Array.isArray(value.tokens) ||
    value.tokens.some(
      (token: unknown) =>
        typeof token !== 'string' || !token || token.length > 4096
    )
  )
    throw new Error('通知登记凭据无法读取，原始数据已保留')
  return { version: 1, tokens: [...new Set<string>(value.tokens)] }
}

const cancelled = () => new ApiError('通知登记已取消', 0, 'ABORTED')

/** One queue per host drains accepted writes before removal. A durable token is saved
 * before PUT, so a restart, timeout or lost response cannot lose the revoke proof. */
export class PushRegistrationCoordinator {
  private queues = new Map<string, Promise<unknown>>()
  private blocked = new Set<string>()
  private removals = new Map<string, Promise<unknown>>()
  private localCleanup = new Map<string, Set<() => Promise<void>>>()
  constructor(private secrets: Storage) {}

  register(
    client: PushClient,
    input: PushRegistrationInput,
    signal?: AbortSignal
  ): Promise<PushRegistrationResult> {
    const hostId = client.host.id
    if (hostId !== input.hostId)
      return Promise.reject(new Error('通知登记的电脑不匹配'))
    if (this.blocked.has(hostId) || signal?.aborted)
      return Promise.reject(cancelled())
    return this.serial(hostId, async () => {
      const check = () => {
        if (this.blocked.has(hostId) || signal?.aborted) throw cancelled()
      }
      check()
      const deviceToken =
        input.kind === 'liveActivity' ? input.deviceToken : input.token
      if (!deviceToken) throw new Error('锁屏活动缺少设备通知凭据')
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
      const result = await client.request<PushRegistrationResult>(
        '/api/sessions/mobile-push',
        { method: 'PUT', body: input, timeoutMs: 8000 }
      )
      if (result.registered && !result.id)
        throw new ApiError('服务器未返回通知登记编号', 0, 'INVALID_RESPONSE')
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
          throw new Error('通知注销的电脑不匹配')
        const proof = migratePushProofs(
          await this.secrets.getItem(pushProofKey(hostId))
        )
        if (proof.tokens.length && !client)
          throw new Error(
            '无法读取这台电脑的连接凭据，通知尚未注销；连接已保留'
          )
        if (client) await this.revokeAll(client)
      })
      // These callbacks only end the native UI. The collection DELETE already
      // retired every associated Live Activity, including process-recovered ones.
      for (const cleanup of this.localCleanup.get(hostId) ?? []) await cleanup()
      return this.serial(hostId, async () => {
        await this.secrets.removeItem(pushProofKey(hostId))
        return removeLocal()
      })
    })()
      .catch((error) => {
        this.blocked.delete(hostId)
        throw new Error(
          `移除未完成，电脑和凭据已保留。${error instanceof Error ? error.message : '请连接电脑后重试'}`
        )
      })
      .finally(() => {
        this.removals.delete(hostId)
      })
    this.removals.set(hostId, result)
    return result
  }

  private async revokeAll(client: PushClient) {
    const proof = migratePushProofs(
      await this.secrets.getItem(pushProofKey(client.host.id))
    )
    for (const token of proof.tokens)
      await client.request<{ removed: number }>('/api/sessions/mobile-push', {
        method: 'DELETE',
        body: { token, hostId: client.host.id },
        timeoutMs: 6000,
      })
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
