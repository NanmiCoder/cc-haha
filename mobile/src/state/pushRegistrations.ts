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
  /** 告诉电脑这台手机怎么投递（渠道、时效性通知、锁屏活动过滤）；旧版电脑不认识。 */
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
 * 登记时附带的投递方式。Android 只声明渠道已拆分（调用方必须先创建好渠道才传
 * channelsReady）；iOS 带上时效性通知和锁屏活动的过滤设置。
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
/** 移除一台电脑时，最多花这么久请它注销本机的通知登记。 */
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
        // 旧版电脑严格校验登记字段，遇到 delivery 会整体回 400：去掉后重试一次。
        if (!(input.delivery && error instanceof ApiError && error.status === 400))
          throw error
        const { delivery: _delivery, ...legacy } = input
        result = await put(legacy)
      }
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
          throw new Error('通知注销的电脑不匹配')
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
          `移除未完成，电脑和凭据已保留。${error instanceof Error ? error.message : '请稍后重试'}`
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
        // 电脑已经不认这份凭据（重新配对后旧条目、电脑清了授权）：远程撤销不可能成功，
        // 当作已撤销，登记凭证才不会因为反复重试而永远留着。
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
