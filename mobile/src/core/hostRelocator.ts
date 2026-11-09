import { ApiError, type ApiClient } from './client'
import type { HostUrlUpdate } from './notifications'
import { parseLocatorHints, verifyHostUrlPush, type LocatorHints } from './relocate'
import type { Host } from './types'

/** 同一台电脑连不上时，最多这么久在局域网里找一次新地址。 */
export const LOCATE_COOLDOWN_MS = 30_000
/** 局域网线索（端口、IP）多久向电脑重新要一次。 */
export const HINTS_MAX_AGE_MS = 6 * 3600_000
/** 要线索失败（不是旧电脑）后，隔多久再要。 */
export const HINTS_RETRY_MS = 10 * 60_000

export type LocatorRecord = LocatorHints & { updatedAt: number }
export type LocatorStore = {
  get(id: string): Promise<LocatorRecord | null>
  set(id: string, record: LocatorRecord): Promise<void>
  retain(ids: readonly string[]): Promise<void>
}
/** App 的电脑登记表（AppContext 挂上来）。 */
export type RelocationTarget = {
  host(id: string): Host | undefined
  credential(id: string): Promise<string | null>
  relocate(id: string, url: string): Promise<void>
}
type LocatorClient = Pick<ApiClient, 'host' | 'get'>

/** Cloudflare 收到了请求却够不着电脑：隧道没了（530）或电脑那头没回应（502–504）。 */
const GATEWAY_STATUSES = new Set([502, 503, 504, 530])
/** 网络层面连不上（没回应、超时、DNS、断连、网关错误）；授权、配对失败都不算。 */
export function isUnreachable(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT' || GATEWAY_STATUSES.has(error.status))
  )
}

/**
 * 远程电脑公网地址变了时把它找回来，全 App 只此一处（见 state/api.ts 的 createApiClient：
 * 每个发往远程电脑的请求结束时都报到这里）：
 * - 请求成功：线索没有或超过 6 小时，就向电脑要一份局域网线索存起来；
 * - 网络原因连不上：同一台电脑 30 秒内最多一次，按线索在局域网里问出新地址，
 *   签名对、和登记的不同，就改登记——各处的客户端随之换成新地址重来。
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

  /** 一个请求结束：`null` 是成功，否则是它的错误。 */
  settled(client: LocatorClient, error: unknown) {
    if (error === null) void this.contacted(client)
    else if (isUnreachable(error)) void this.unreachable(client.host)
  }

  /** 只留登记表里还在的电脑：删掉的电脑连同它的线索一起忘掉。 */
  retain(ids: readonly string[]) {
    const kept = new Set(ids)
    for (const map of [this.#hintsDue, this.#locatedAt])
      for (const id of [...map.keys()]) if (!kept.has(id)) map.delete(id)
    return this.deps.hints.retain(ids)
  }

  /** 发请求的客户端还指向登记表里这台电脑的现行地址；换过地址后的旧客户端不算。 */
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
        // 这次运行头一回：存着的线索还新鲜就不问。
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
      // 旧电脑没有这个接口：这次运行内不再问。
      this.#hintsDue.set(
        id,
        error instanceof ApiError && error.status === 404 ? Infinity : this.#now() + HINTS_RETRY_MS
      )
    } finally {
      this.#refreshing.delete(id)
    }
  }

  /** 返回是否改了登记的地址。 */
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
 * 电脑推来的新地址：用这台电脑存着的凭据核对签名。relocated=改了登记；
 * current=签名对、地址没变；ignored=不认识的电脑、没有凭据或签名不对。
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
