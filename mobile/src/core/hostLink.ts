import { ApiError, ApiClient, type FetchAdapter } from './client'
import type { SocketFactory } from './sessionTransport'
import type { Host } from './types'
import { P2PPeer, P2PUnavailable, type RtcFactory, type Signaling } from './p2p/peer'
import { Tunnel } from './p2p/tunnel'

/** cf：经 Cloudflare；lan：同一局域网直连；direct：跨网直连。 */
export type LinkPath = 'cf' | 'lan' | 'direct'
type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** 第一次用到这台电脑后多久开始升级：先让 Cloudflare 上的首屏请求跑完。 */
export const UPGRADE_DELAY_MS = 1500
/** 连不上直连之后，隔多久再试；切网、回前台时立刻重试。 */
export const COOLDOWN_MS = [5_000, 15_000, 60_000, 300_000]
/**
 * 电脑没开直连（开关关了，或电脑刚启动、直连宿主还没起来）：一分钟后再问。
 * 回前台、切网不清零它，免得每次回来都白问一趟。
 */
export const UNAVAILABLE_RECHECK_MS = 60_000
/** 旧电脑没有直连接口：这次运行内不再问。 */
export const UNSUPPORTED_MS = 24 * 3600_000
/** 离开超过这么久，直连多半已被系统掐断：回来先走 Cloudflare，再重新协商。 */
export const STALE_AFTER_BACKGROUND_MS = 10_000
/** 在后台待满这么久就主动关掉直连，省电省资源。 */
export const BACKGROUND_CLOSE_MS = 60_000

/**
 * 到一台远程电脑的连接路径。始终先走 Cloudflare（马上能用），后台尝试升级成
 * 直连；直连可用时 HTTP 和会话套接字都改走它，断了就无感退回 Cloudflare
 * （会话靠续传接回，不读历史）。没有自建服务器：信令走 Cloudflare 网关。
 */
export class HostLink {
  path: LinkPath = 'cf'
  #peer?: P2PPeer
  #tunnel?: Tunnel
  #negotiating = false
  #failures = 0
  #notBefore = 0
  /** 眼下的冷却从哪来：只有「连不上」会被回前台、切网提前结束。 */
  #cooling?: 'failure' | 'unavailable' | 'unsupported'
  #scheduled?: unknown
  #backgroundTimer?: unknown
  #hiddenAt?: number
  #disposed = false
  #listeners = new Set<(path: LinkPath) => void>()
  #timers: Timers
  #now: () => number

  constructor(
    private options: {
      host: Host
      credential: string
      cfFetch: FetchAdapter
      cfSocket: SocketFactory
      /** 原生 WebRTC 不在（旧安装包、H5）时不提供，始终走 Cloudflare。 */
      rtc?: RtcFactory
      timers?: Timers
      now?: () => number
    }
  ) {
    this.#timers = options.timers ?? defaultTimers
    this.#now = options.now ?? Date.now
  }

  get enabled() {
    return !!this.options.rtc && this.options.host.auth === 'remote'
  }

  get credential() {
    return this.options.credential
  }

  fetch: FetchAdapter = async (input, init) => {
    const tunnel = this.#tunnel
    if (!tunnel || tunnel.closed) {
      this.#schedule()
      return this.options.cfFetch(input, init)
    }
    try {
      // 直连在收到答复头时就交回；正文路上断了由读正文时报错，不在这里重发。
      return await tunnel.fetch(input, init)
    } catch (error) {
      // 直连在答复头到之前断了：GET 没有副作用，改走 Cloudflare 再试；别的请求不重发。
      if (init.signal.aborted || (init.method !== 'GET' && init.method !== 'HEAD')) throw error
      return this.options.cfFetch(input, init)
    }
  }

  socketFactory: SocketFactory = (options) => {
    const tunnel = this.#tunnel
    if (tunnel && !tunnel.closed) return tunnel.socket(options.url, options.headers)
    this.#schedule()
    return this.options.cfSocket(options)
  }

  onPathChange(listener: (path: LinkPath) => void) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** 换了网络：旧直连可能已经不通，冷却也作废，马上重新试。 */
  networkChanged() {
    if (this.path !== 'cf') this.#peer?.close()
    this.#retryNow()
  }

  background() {
    this.#hiddenAt = this.#now()
    this.#timers.clear(this.#backgroundTimer)
    this.#backgroundTimer = this.#timers.set(() => this.#peer?.close(), BACKGROUND_CLOSE_MS)
  }

  foreground() {
    this.#timers.clear(this.#backgroundTimer)
    const away = this.#hiddenAt === undefined ? 0 : this.#now() - this.#hiddenAt
    this.#hiddenAt = undefined
    if (away >= STALE_AFTER_BACKGROUND_MS && this.path !== 'cf') this.#peer?.close()
    if (this.path === 'cf') this.#retryNow()
  }

  dispose() {
    this.#disposed = true
    this.#timers.clear(this.#scheduled)
    this.#timers.clear(this.#backgroundTimer)
    this.#peer?.close()
    this.#listeners.clear()
  }

  #retryNow() {
    this.#failures = 0
    // 只提前结束「连不上」的冷却：换了网络、回到前台，上次连不上的原因可能已经不在了。
    // 电脑没开直连、旧电脑不支持，和手机这边的变化无关，照旧等。
    if (this.#cooling === 'failure') {
      this.#notBefore = 0
      this.#cooling = undefined
    }
    this.#timers.clear(this.#scheduled)
    this.#scheduled = undefined
    this.#schedule(0)
  }

  #schedule(delay = UPGRADE_DELAY_MS) {
    if (!this.enabled || this.#disposed || this.#peer || this.#negotiating || this.#scheduled !== undefined) return
    if (this.#hiddenAt !== undefined) return
    const wait = Math.max(delay, this.#notBefore - this.#now())
    this.#scheduled = this.#timers.set(() => {
      this.#scheduled = undefined
      void this.#upgrade()
    }, wait)
  }

  async #upgrade() {
    if (!this.enabled || this.#disposed || this.#peer || this.#negotiating) return
    this.#negotiating = true
    let tunnel: Tunnel | undefined
    const peer: P2PPeer = new P2PPeer({
      rtc: this.options.rtc!,
      signaling: this.#signaling(),
      timers: this.#timers,
      onFrame: (text) => tunnel?.receive(text),
      onClose: () => this.#lost(peer),
    })
    tunnel = new Tunnel({ send: (channel, text) => peer.send(channel, text) })
    this.#peer = peer
    try {
      const path = await peer.connect()
      if (this.#disposed || this.#peer !== peer) {
        peer.close()
        return
      }
      this.#tunnel = tunnel
      this.#failures = 0
      this.#setPath(path)
    } catch (error) {
      if (this.#peer === peer) this.#peer = undefined
      this.#cooldown(error)
    } finally {
      this.#negotiating = false
    }
  }

  #lost(peer: P2PPeer) {
    if (this.#peer !== peer) return
    this.#peer = undefined
    const tunnel = this.#tunnel
    this.#tunnel = undefined
    // 套接字以网络断开收尾：会话按续传经 Cloudflare 接回，不读历史。
    tunnel?.close()
    if (this.path !== 'cf') {
      this.#setPath('cf')
      this.#notBefore = this.#now() + COOLDOWN_MS[0]!
      this.#cooling = 'failure'
      this.#schedule()
    }
  }

  #cooldown(error: unknown) {
    if (error instanceof ApiError && error.status === 404) {
      this.#notBefore = this.#now() + UNSUPPORTED_MS
      this.#cooling = 'unsupported'
    } else if (error instanceof P2PUnavailable) {
      this.#notBefore = this.#now() + UNAVAILABLE_RECHECK_MS
      this.#cooling = 'unavailable'
    } else {
      this.#notBefore = this.#now() + COOLDOWN_MS[Math.min(this.#failures++, COOLDOWN_MS.length - 1)]!
      this.#cooling = 'failure'
    }
  }

  #setPath(path: LinkPath) {
    if (this.path === path) return
    this.path = path
    for (const listener of [...this.#listeners]) listener(path)
  }

  /** 信令总走 Cloudflare：直连还没建好，也不该靠它自己来建。 */
  #signaling(): Signaling {
    const api = new ApiClient(this.options.host, this.options.credential, { fetch: this.options.cfFetch })
    return {
      info: () => api.get('/api/public-access/p2p'),
      offer: (body) => api.post('/api/public-access/p2p/offer', body),
      candidates: (body) => api.post('/api/public-access/p2p/candidates', body, { timeoutMs: 6000 }),
    }
  }
}

/** 每台电脑一个连接路径，聊天页和 HTTP 共用。 */
const links = new Map<string, HostLink>()
/** 释放一台电脑的连接路径：关掉直连，之后回前台、切网也不再替它发信令。 */
function forget(id: string) {
  links.get(id)?.dispose()
  links.delete(id)
}
export const hostLinks = {
  /** 凭据换了（重新配对）就换一个新的，旧的随之释放。 */
  for(host: Host, credential: string, factory: () => HostLink) {
    const key = host.id
    let link = links.get(key)
    if (!link || link.credential !== credential) {
      link?.dispose()
      link = factory()
      links.set(key, link)
    }
    return link
  },
  get(host: Host) {
    return links.get(host.id)
  },
  all() {
    return [...links.values()]
  },
  forget,
  /** 只留登记表里还在的电脑；删掉的电脑不再协商直连。 */
  retain(ids: readonly string[]) {
    const kept = new Set(ids)
    for (const id of [...links.keys()]) if (!kept.has(id)) forget(id)
  },
}
