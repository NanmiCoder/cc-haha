import type { Host } from '../core/types'
import { normalizeHostUrl } from '../core/connection'

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
