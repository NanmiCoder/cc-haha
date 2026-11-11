import type { Host } from '../core/types'
import { normalizeHostUrl } from '../core/connection'
import type { LocatorRecord, LocatorStore } from '../core/hostRelocator'
import { parseLocatorHints } from '../core/relocate'
import { parseRemoteIdentity } from '../core/remoteIdentity'

export type Storage = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}
export type Registry = { version: 2; hosts: Host[]; selectedId: string | null }
const key = 'cc-haha.hosts'
const empty = (): Registry => ({ version: 2, hosts: [], selectedId: null })
const credentialKey = (id: string) => `cc-haha.host.${id}`

export class Drafts {
  private values = new Map<string, string>()
  get(key: string) {
    return this.values.get(key)
  }
  set(key: string, value: string) {
    this.values.set(key, value)
  }
  delete(key: string) {
    this.values.delete(key)
  }
  removeHost(id: string) {
    for (const key of this.values.keys())
      if (key.startsWith(`${id}:`)) this.values.delete(key)
  }
}

/** v0/v1 hosts retain their separate credentials; v2 adds public device identity metadata. */
export function migrateRegistry(raw: string | null): Registry {
  if (!raw) return empty()
  const value = JSON.parse(raw)
  if (value.version !== undefined && ![0, 1, 2].includes(value.version))
    throw new Error('主机列表来自更新的 App 版本，请先升级')
  if (!Array.isArray(value.hosts))
    throw new Error('主机列表无法读取，原始数据已保留')
  const ids = new Set<string>()
  const hosts: Host[] = value.hosts.map((item: Record<string, unknown>) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      typeof item.url !== 'string' ||
      !['lan', 'remote'].includes(String(item.auth))
    )
      throw new Error('主机列表格式无效，原始数据已保留')
    ids.add(item.id)
    const auth = item.auth as Host['auth']
    if (item.remoteIdentity !== undefined && auth !== 'remote')
      throw new Error('局域网主机不能包含公网身份')
    return {
      id: item.id,
      name: item.name,
      url: normalizeHostUrl(item.url, auth),
      auth,
      ...(value.version === 2 && item.remoteIdentity !== undefined
        ? { remoteIdentity: parseRemoteIdentity(item.remoteIdentity) }
        : {}),
    }
  })
  return {
    version: 2,
    hosts,
    selectedId: ids.has(value.selectedId)
      ? value.selectedId
      : (hosts[0]?.id ?? null),
  }
}

export class HostRepository {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private metadata: Storage,
    private secrets: Storage
  ) {}
  private transaction<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => {})
    return result
  }
  load() {
    return this.transaction(async () => {
      const raw = await this.metadata.getItem(key)
      const registry = migrateRegistry(raw)
      if (raw && raw !== JSON.stringify(registry))
        await this.metadata.setItem(key, JSON.stringify(registry))
      return registry
    })
  }
  credential(id: string) {
    return this.secrets.getItem(credentialKey(id))
  }
  add(host: Host, credential: string, signal?: AbortSignal) {
    return this.transaction(async () => {
      const checkCancelled = () => {
        if (signal?.aborted) throw new Error('连接已取消')
      }
      checkCancelled()
      const registry = migrateRegistry(await this.metadata.getItem(key))
      if (registry.hosts.some((item) => item.id === host.id))
        throw new Error('主机标识已存在')
      const next = migrateRegistry(
        JSON.stringify({
          version: 2,
          hosts: [...registry.hosts, host],
          selectedId: host.id,
        })
      )
      checkCancelled()
      await this.secrets.setItem(credentialKey(host.id), credential)
      try {
        checkCancelled()
        await this.metadata.setItem(key, JSON.stringify(next))
        if (signal?.aborted) {
          await this.metadata.setItem(key, JSON.stringify(registry))
          checkCancelled()
        }
      } catch (error) {
        await this.secrets.removeItem(credentialKey(host.id)).catch(() => {})
        throw error
      }
      return next
    })
  }
  select(id: string) {
    return this.transaction(async () => {
      const next = migrateRegistry(await this.metadata.getItem(key))
      if (!next.hosts.some((host) => host.id === id))
        throw new Error('主机不存在')
      next.selectedId = id
      await this.metadata.setItem(key, JSON.stringify(next))
      return next
    })
  }
  /**
   * A remote computer's public address moved (its tunnel restarted). Only the
   * address changes; the id, name, kind and stored credential stay. `null` when
   * it already has this address.
   */
  updateUrl(id: string, url: string) {
    return this.transaction(async () => {
      const current = migrateRegistry(await this.metadata.getItem(key))
      const host = current.hosts.find((item) => item.id === id)
      if (!host) throw new Error('主机不存在')
      if (host.auth !== 'remote') throw new Error('只有远程连接的电脑会更换地址')
      if (host.remoteIdentity) throw new Error('电脑身份连接必须先验证新地址')
      const origin = normalizeHostUrl(url, 'remote')
      if (origin === host.url) return null
      const next: Registry = {
        ...current,
        hosts: current.hosts.map((item) => (item.id === id ? { ...item, url: origin } : item)),
      }
      await this.metadata.setItem(key, JSON.stringify(next))
      return next
    })
  }
  /** Commit verified endpoint and token changes together and keep removed hosts removed. */
  updateConnection(previous: Host, host: Host, credential: string, signal?: AbortSignal) {
    return this.transaction(async () => {
      if (signal?.aborted) throw new Error('连接已取消')
      const current = migrateRegistry(await this.metadata.getItem(key))
      const index = current.hosts.findIndex((value) => value.id === previous.id)
      const normalizedPrevious = migrateRegistry(JSON.stringify({
        version: 2,
        hosts: [previous],
        selectedId: previous.id,
      })).hosts[0]
      if (index < 0 || JSON.stringify(current.hosts[index]) !== JSON.stringify(normalizedPrevious))
        throw new Error('主机信息已改变，请重试连接')
      const before = previous.remoteIdentity
      const after = host.remoteIdentity
      if (
        host.id !== previous.id || host.auth !== 'remote' || !before || !after ||
        after.hostId !== before.hostId || after.hostKey !== before.hostKey ||
        after.directory !== before.directory || after.deviceId !== before.deviceId ||
        after.sequence < before.sequence
      ) throw new Error('电脑身份不匹配')

      const priorCredential = await this.credential(host.id)
      const next = migrateRegistry(JSON.stringify({
        ...current,
        hosts: current.hosts.map((value, at) => at === index ? host : value),
      }))
      await this.secrets.setItem(credentialKey(host.id), credential)
      try {
        if (signal?.aborted) throw new Error('连接已取消')
        await this.metadata.setItem(key, JSON.stringify(next))
        if (signal?.aborted) {
          await this.metadata.setItem(key, JSON.stringify(current))
          throw new Error('连接已取消')
        }
      } catch (error) {
        if (priorCredential === null) await this.secrets.removeItem(credentialKey(host.id))
        else await this.secrets.setItem(credentialKey(host.id), priorCredential)
        throw error
      }
      return next
    })
  }
  remove(id: string) {
    return this.transaction(async () => {
      const current = migrateRegistry(await this.metadata.getItem(key))
      const hosts = current.hosts.filter((host) => host.id !== id)
      const next: Registry = {
        version: 2,
        hosts,
        selectedId:
          current.selectedId === id
            ? (hosts[0]?.id ?? null)
            : current.selectedId,
      }
      const credential = await this.secrets.getItem(credentialKey(id))
      await this.secrets.removeItem(credentialKey(id))
      try {
        await this.metadata.setItem(key, JSON.stringify(next))
      } catch (error) {
        if (credential !== null)
          await this.secrets.setItem(credentialKey(id), credential)
        throw error
      }
      return next
    })
  }
}

const locatorsKey = 'cc-haha.host-locators'
/**
 * 远程电脑的局域网线索（端口 + IPv4，见 core/hostRelocator.ts），按电脑 id 存：
 * `{ version: 1, hosts: { [id]: { port, addresses, updatedAt } } }`。
 * 随时能向电脑重新要，所以没有、损坏或来自更新版本都当作空，不报错；
 * 单条格式不对只丢那一条。
 */
export function parseHostLocators(raw: string | null): Map<string, LocatorRecord> {
  const records = new Map<string, LocatorRecord>()
  let value: unknown
  try {
    value = raw ? JSON.parse(raw) : null
  } catch {
    return records
  }
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1)
    return records
  const hosts = (value as { hosts?: unknown }).hosts
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) return records
  for (const [id, entry] of Object.entries(hosts)) {
    const hints = /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? parseLocatorHints(entry) : null
    const updatedAt = (entry as { updatedAt?: unknown } | null)?.updatedAt
    if (hints && typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0)
      records.set(id, { ...hints, updatedAt })
  }
  return records
}

export class HostLocators implements LocatorStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private storage: Storage) {}
  private transaction<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => {})
    return result
  }
  private async read() {
    return parseHostLocators(await this.storage.getItem(locatorsKey))
  }
  private write(records: Map<string, LocatorRecord>) {
    return records.size
      ? this.storage.setItem(
          locatorsKey,
          JSON.stringify({ version: 1, hosts: Object.fromEntries(records) })
        )
      : this.storage.removeItem(locatorsKey)
  }
  get(id: string) {
    return this.transaction(async () => (await this.read()).get(id) ?? null)
  }
  set(id: string, record: LocatorRecord) {
    return this.transaction(async () => {
      const records = await this.read()
      records.set(id, record)
      await this.write(records)
    })
  }
  /** Drops computers no longer on this phone; writes only when something goes. */
  retain(ids: readonly string[]) {
    return this.transaction(async () => {
      const kept = new Set(ids)
      const records = await this.read()
      const before = records.size
      for (const id of [...records.keys()]) if (!kept.has(id)) records.delete(id)
      if (records.size !== before) await this.write(records)
    })
  }
}
