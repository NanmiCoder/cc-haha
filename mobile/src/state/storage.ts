import type { Host } from '../core/types'
import { normalizeHostUrl } from '../core/connection'
import type { LocatorRecord, LocatorStore } from '../core/hostRelocator'
import { parseLocatorHints } from '../core/relocate'

export type Storage = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}
export type Registry = { version: 1; hosts: Host[]; selectedId: string | null }
const key = 'cc-haha.hosts'
const empty = (): Registry => ({ version: 1, hosts: [], selectedId: null })
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

/** Version 0 is the initial, unversioned metadata shape. Credentials never migrate into JSON. */
export function migrateRegistry(raw: string | null): Registry {
  if (!raw) return empty()
  const value = JSON.parse(raw)
  if (value.version !== undefined && value.version !== 0 && value.version !== 1)
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
    return {
      id: item.id,
      name: item.name,
      url: normalizeHostUrl(item.url, auth),
      auth,
    }
  })
  return {
    version: 1,
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
          version: 1,
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
  remove(id: string) {
    return this.transaction(async () => {
      const current = migrateRegistry(await this.metadata.getItem(key))
      const hosts = current.hosts.filter((host) => host.id !== id)
      const next: Registry = {
        version: 1,
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
