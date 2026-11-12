import { ApiError, ApiClient, type FetchAdapter } from './client'
import type { SocketFactory } from './sessionTransport'
import type { Host } from './types'
import { P2PPeer, P2PUnavailable, type P2PInfo, type RtcFactory, type Signaling } from './p2p/peer'
import { Tunnel } from './p2p/tunnel'

/** cf: through Cloudflare; lan: direct on the same LAN; direct: direct across networks. */
export type LinkPath = 'cf' | 'lan' | 'direct'
type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** How long after first using this computer to start upgrading: let the first-screen requests over Cloudflare finish first. */
export const UPGRADE_DELAY_MS = 1500
/** How long to wait before retrying after direct fails; retry immediately on network switch or return to foreground. */
export const COOLDOWN_MS = [5_000, 15_000, 60_000, 300_000]
/**
 * Direct not enabled on the computer (toggle off, or the computer just started and the direct host is not up yet): ask again in one minute.
 * Returning to foreground or switching networks does not reset it, to avoid a wasted ask every time.
 */
export const UNAVAILABLE_RECHECK_MS = 60_000
/** Old computers have no direct endpoint: do not ask again during this run. */
export const UNSUPPORTED_MS = 24 * 3600_000
/**
 * After being away longer than this, direct may have been cut by the system or network: on return first ask over the old direct path
 * (limited to FOREGROUND_PROBE_MS); if alive keep using it; only if dead fall back to Cloudflare and renegotiate immediately.
 */
export const STALE_AFTER_BACKGROUND_MS = 10_000
/** Time limit for probing the old direct path on return to foreground: a direct round trip is usually under 100 ms, while one Cloudflare request takes over half a second. */
export const FOREGROUND_PROBE_MS = 1500
/** After staying in background this long, proactively close direct to save power and resources. */
export const BACKGROUND_CLOSE_MS = 60_000
/** Offer response code when the direct host on the computer is absent (toggle off, or just started and not up yet) (see src/server/p2p/broker.ts). */
const P2P_UNAVAILABLE_CODE = 'P2P_UNAVAILABLE'

/**
 * Connection path to a remote computer. Always use Cloudflare first (usable right away), and in the background try upgrading to
 * direct; when direct is available HTTP and session sockets switch to it, and fall back seamlessly when it drops Cloudflare
 * (sessions resume without reading history). No self-hosted server: signaling goes through the Cloudflare gateway.
 */
export class HostLink {
  path: LinkPath = 'cf'
  #peer?: P2PPeer
  #tunnel?: Tunnel
  #negotiating = false
  /** Direct path being confirmed on return to foreground (see `foreground`). */
  #checking?: P2PPeer
  /**
   * Last fetched direct info (STUN servers are fixed computer config): remembered for this run so that when renegotiating
   * we send the offer directly, saving a round trip through Cloudflare. Invalidated when the computer answers direct is off or unsupported.
   */
  #info?: P2PInfo
  #failures = 0
  #notBefore = 0
  /** Where the current cooldown comes from: only "unreachable" is ended early by foreground return or network switch. */
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
      /** Not provided when native WebRTC is absent (old install, H5); always use Cloudflare. */
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
    const resendable = init.method === 'GET' || init.method === 'HEAD'
    // Confirming whether direct is still alive on return to foreground (up to FOREGROUND_PROBE_MS): non-resendable requests go via Cloudflare first, 
    // to avoid landing on a dead path with no way to reroute and resend. GET still goes direct; if dead it disconnects on timeout and switches to Cloudflare.
    if (this.#checking && !resendable) return this.options.cfFetch(input, init)
    try {
      // Direct hands back as soon as the response headers arrive; if the body breaks midway the body read errors, with no resend here.
      return await tunnel.fetch(input, init)
    } catch (error) {
      // Direct dropped before the response headers: GET has no side effects, so retry via Cloudflare; other requests are not resent.
      if (init.signal.aborted || !resendable) throw error
      return this.options.cfFetch(input, init)
    }
  }

  /**
   * Sockets opened while confirming on return to foreground also go direct: if the path is dead they disconnect on timeout, finish as a network disconnect, and Cloudflare
   * reconnect via resume; if switched to Cloudflare the path is unchanged after confirmation, so it stays on Cloudflare.
   */
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

  /** Network changed: the old direct path may be dead and the cooldown is void; retry immediately. */
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
    const peer = this.#peer
    if (away >= STALE_AFTER_BACKGROUND_MS && this.path !== 'cf' && peer) void this.#check(peer)
    else if (this.path === 'cf') this.#retryNow()
  }

  dispose() {
    this.#disposed = true
    this.#timers.clear(this.#scheduled)
    this.#timers.clear(this.#backgroundTimer)
    this.#peer?.close()
    this.#listeners.clear()
  }

  /** After being away a long time, ask over the old direct path first: if alive keep using it without renegotiating; if not, disconnect and renegotiate immediately. */
  async #check(peer: P2PPeer) {
    if (this.#checking === peer) return
    this.#checking = peer
    const alive = await peer.check(FOREGROUND_PROBE_MS)
    if (this.#checking === peer) this.#checking = undefined
    if (alive || this.#disposed) return
    // Closing it reverts the path to Cloudflare; sockets on direct finish as a network disconnect and resume via Cloudflare.
    peer.close()
    if (this.path === 'cf') this.#retryNow()
  }

  #retryNow() {
    this.#failures = 0
    // Only end the "unreachable" cooldown early: after a network change or return to foreground the cause of the last failure may be gone.
    // Direct not enabled on the computer, or an old computer without support, is unrelated to phone-side changes, so keep waiting.
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
    // Sockets finish as a network disconnect: the session resumes via Cloudflare without reading history.
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
      this.#info = undefined
      this.#notBefore = this.#now() + UNSUPPORTED_MS
      this.#cooling = 'unsupported'
    } else if (error instanceof P2PUnavailable) {
      this.#info = undefined
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

  /** Signaling always goes through Cloudflare: direct is not established yet and should not build itself. */
  #signaling(): Signaling {
    const api = new ApiClient(this.options.host, this.options.credential, { fetch: this.options.cfFetch })
    return {
      info: async () => {
        if (this.#info) return this.#info
        const info = await api.get<P2PInfo>('/api/public-access/p2p')
        // Only remember "on": if off, ask again in one minute.
        if (info.available) this.#info = info
        return info
      },
      offer: (body) =>
        api.post<Awaited<ReturnType<Signaling['offer']>>>('/api/public-access/p2p/offer', body).catch((error: unknown) => {
          // When the info endpoint is skipped, direct being disabled on the computer must be read from the offer response: handle it like the info endpoint answering "off".
          if (error instanceof ApiError && error.status === 503 && error.code === P2P_UNAVAILABLE_CODE)
            throw new P2PUnavailable(error.message)
          throw error
        }),
      candidates: (body) => api.post('/api/public-access/p2p/candidates', body, { timeoutMs: 6000 }),
    }
  }
}

/** One connection path per computer, shared by the chat page and HTTP. */
const links = new Map<string, HostLink>()
/** Release a computer's connection path: close direct, and stop signaling for it on later foreground returns or network switches. */
function forget(id: string) {
  links.get(id)?.dispose()
  links.delete(id)
}
export const hostLinks = {
  /** When credentials change (re-pairing) create a new one and release the old one. */
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
  /** Keep only computers still in the registry; deleted computers no longer negotiate direct. */
  retain(ids: readonly string[]) {
    const kept = new Set(ids)
    for (const id of [...links.keys()]) if (!kept.has(id)) forget(id)
  },
}
