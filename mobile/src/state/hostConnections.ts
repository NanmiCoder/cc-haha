import type { ApiClient } from '../core/client'
import { recoverRemoteConnection, type RemoteIdentityKeys } from '../core/remoteIdentity'
import type { Host } from '../core/types'
import type { HostRepository, Registry } from './storage'

type Resolved = { host: Host; credential: string; registry?: Registry }

/** Screens share one renewal per host, so concurrent readers cannot invalidate each other's token. */
export class HostConnections {
  private running = new Map<string, { controller: AbortController; promise: Promise<Resolved> }>()
  private recent = new Map<string, { at: number; value: Resolved }>()
  constructor(private repository: HostRepository, private client: (host: Host, credential: string) => ApiClient,
    private keys: RemoteIdentityKeys | null, private now = Date.now) {}

  resolve(id: string): Promise<Resolved> {
    const running = this.running.get(id)
    if (running) return running.promise
    const recent = this.recent.get(id)
    if (recent && this.now() - recent.at < 10_000) return Promise.resolve(recent.value)
    const controller = new AbortController()
    const promise = this.load(id, controller.signal).then(value => {
      if (controller.signal.aborted) throw new Error('连接已取消')
      this.recent.set(id, { at: this.now(), value })
      return value
    }).finally(() => { if (this.running.get(id)?.controller === controller) this.running.delete(id) })
    this.running.set(id, { controller, promise })
    return promise
  }

  forget(id: string) {
    this.running.get(id)?.controller.abort()
    this.running.delete(id)
    this.recent.delete(id)
  }

  private async load(id: string, signal: AbortSignal): Promise<Resolved> {
    const registry = await this.repository.load()
    const host = registry.hosts.find(value => value.id === id)
    if (!host || signal.aborted) throw new Error('主机已移除')
    const credential = await this.repository.credential(id)
    if (!host.remoteIdentity) {
      if (!credential) throw new Error('连接凭据已失效，请移除主机后重新连接')
      return { host, credential }
    }
    if (!this.keys) throw new Error('此设备尚不支持电脑身份恢复，请使用新版 Android App')
    const result = await recoverRemoteConnection(host, credential ?? '', {
      client: this.client, keys: this.keys, signal, now: this.now,
    })
    if (JSON.stringify(host) === JSON.stringify(result.host) && credential === result.credential) return result
    const next = await this.repository.updateConnection(host, result.host, result.credential, signal)
    return { ...result, registry: next }
  }
}
