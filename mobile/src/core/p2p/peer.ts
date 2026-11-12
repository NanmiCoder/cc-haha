import { encodeFrame, decodeFrame, type P2PChannel } from './frames'

/** The small part of WebRTC that is used; the native library and test doubles both follow it. */
export type RtcChannel = {
  readonly readyState: string
  send(text: string): void
  close(): void
  on(event: 'open' | 'close', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
}
export type RtcPeer = {
  createChannel(label: P2PChannel, id: number): RtcChannel
  /** Create an offer, set it as local description, and return the SDP. */
  createOffer(): Promise<string>
  setAnswer(sdp: string): Promise<void>
  addCandidate(candidate: string): Promise<void>
  /** null means gathering is complete. */
  onCandidate(listener: (candidate: string | null) => void): void
  onState(listener: (state: string) => void): void
  /** It is lan when both ends of the selected candidate pair are private addresses. */
  selectedPath(): Promise<'lan' | 'direct'>
  close(): void
}
export type RtcFactory = (config: { iceServers: unknown[] }) => RtcPeer
/** The computer's direct info: whether enabled, which STUN servers, and how long to gather candidates. */
export type P2PInfo = { available: boolean; iceServers: unknown[]; gatherMs?: number }
export type Signaling = {
  info(): Promise<P2PInfo>
  offer(body: { v: 1; sdp: string; candidates: string[]; complete: boolean }): Promise<{ peerId: string; sdp: string; candidates: string[]; complete: boolean }>
  candidates(body: { peerId: string; candidates: string[]; complete: boolean }): Promise<{ candidates: string[]; complete: boolean }>
}
type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }

/** Total deadline for negotiation plus channel open: on timeout keep using Cloudflare. */
export const P2P_CONNECT_MS = 8000
export const P2P_HEALTH_MS = 5000
export const P2P_PONG_MS = 1500

export class P2PUnavailable extends Error {}

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:)/i
/** Both ends of the selected candidate pair are private addresses: same LAN. */
export function classifyPath(local?: string, remote?: string): 'lan' | 'direct' {
  return local && remote && PRIVATE.test(local) && PRIVATE.test(remote) ? 'lan' : 'direct'
}

/**
 * A direct connection to the computer. First exchange offer/answer via Cloudflare (gather candidates for at most gatherMs, 
 * trickle late ones), connected only when both channels open; afterwards probe every 5 seconds, and two consecutive misses
 * (with no other frames received meanwhile) disconnect.
 */
export class P2PPeer {
  #peer?: RtcPeer
  #channels?: Record<P2PChannel, RtcChannel>
  #closed = false
  #ping = 0
  #misses = 0
  #awaiting?: number
  #health?: unknown
  #pongTimer?: unknown
  /** Waiting for confirmation of its own pong (see `check`), by ping sequence number. */
  #checks = new Map<number, (alive: boolean) => void>()

  constructor(
    private options: {
      rtc: RtcFactory
      signaling: Signaling
      timers: Timers
      /** A frame from the computer (excluding heartbeat). */
      onFrame(text: string): void
      /** Direct dropped (called only once). */
      onClose(): void
    }
  ) {}

  get open() {
    return !this.#closed && this.#channels?.ctl.readyState === 'open' && this.#channels.bulk.readyState === 'open'
  }

  async connect(): Promise<'lan' | 'direct'> {
    const info = await this.options.signaling.info()
    if (!info.available) throw new P2PUnavailable('Direct connections are off on this computer')
    const peer = this.options.rtc({ iceServers: info.iceServers })
    this.#peer = peer
    const channels = { ctl: peer.createChannel('ctl', 0), bulk: peer.createChannel('bulk', 1) }
    this.#channels = channels
    const local: string[] = []
    let localComplete = false
    let wake = () => {}
    peer.onCandidate((candidate) => {
      if (candidate) local.push(candidate)
      else localComplete = true
      wake()
    })
    let failed: (error: Error) => void = () => {}
    const failure = new Promise<never>((_, reject) => { failed = reject })
    failure.catch(() => {})
    peer.onState((state) => {
      if (state === 'failed' || state === 'closed') {
        failed(new Error(`Direct connection ${state}`))
        this.close()
      }
      // Network blip: probe first, do not rush to disconnect.
      else if (state === 'disconnected' && this.open) this.#probe()
    })
    const opened = Promise.all(
      (['ctl', 'bulk'] as const).map(
        (label) => new Promise<void>((resolve) => {
          if (channels[label].readyState === 'open') resolve()
          else channels[label].on('open', resolve)
        })
      )
    )
    for (const label of ['ctl', 'bulk'] as const) {
      channels[label].on('message', (data) => this.#receive(data))
      channels[label].on('close', () => this.close())
    }
    const deadline = new Promise<never>((_, reject) => {
      const timer = this.options.timers.set(() => reject(new Error('Direct connection timed out')), P2P_CONNECT_MS)
      opened.finally(() => this.options.timers.clear(timer))
    })
    deadline.catch(() => {})
    const negotiate = async () => {
      const sdp = await peer.createOffer()
      await new Promise<void>((resolve) => {
        if (localComplete) return resolve()
        const timer = this.options.timers.set(resolve, info.gatherMs ?? 800)
        wake = () => {
          if (!localComplete) return
          this.options.timers.clear(timer)
          resolve()
        }
      })
      const answer = await this.options.signaling.offer({ v: 1, sdp, candidates: local.splice(0), complete: localComplete })
      await peer.setAnswer(answer.sdp)
      for (const candidate of answer.candidates) await peer.addCandidate(candidate).catch(() => {})
      // While either side is still gathering, trickle to each other in the background until both finish or the channel opens; connecting does not wait for it.
      void trickle(answer.peerId, answer.complete)
    }
    const trickle = async (id: string, remoteDone: boolean) => {
      let remoteComplete = remoteDone
      let sentComplete = false
      try {
        while (!this.#closed && !this.open && (!remoteComplete || !sentComplete)) {
          const reply = await this.options.signaling.candidates({ peerId: id, candidates: local.splice(0), complete: localComplete })
          sentComplete = localComplete
          for (const candidate of reply.candidates) await peer.addCandidate(candidate).catch(() => {})
          remoteComplete = reply.complete
        }
      } catch {
        // A failed trickle is not a failure: existing candidates may suffice, and a failure to connect is handled by the overall deadline.
      }
    }
    try {
      await Promise.race([Promise.all([negotiate(), opened]), failure, deadline])
      const path = await peer.selectedPath().catch(() => 'direct' as const)
      this.#heartbeat()
      return path
    } catch (error) {
      this.close()
      throw error
    }
  }

  send(channel: P2PChannel, text: string) {
    if (!this.open) return false
    try {
      this.#channels![channel].send(text)
      return true
    } catch {
      this.close()
      return false
    }
  }

  /**
   * Whether this path is still alive right now (asked on return to foreground): send a ping and count it alive only if its own pong arrives in time.
   * Old frames buffered during suspension and pongs from earlier heartbeats only show it was alive back then and do not count.
   * Even if dead, do not disconnect here; the caller decides.
   */
  check(timeoutMs = P2P_PONG_MS): Promise<boolean> {
    if (!this.open) return Promise.resolve(false)
    const n = ++this.#ping
    return new Promise<boolean>((resolve) => {
      const timer = this.options.timers.set(() => settle(false), timeoutMs)
      const settle = (alive: boolean) => {
        if (!this.#checks.delete(n)) return
        this.options.timers.clear(timer)
        resolve(alive)
      }
      this.#checks.set(n, settle)
      if (!this.send('ctl', encodeFrame({ t: 'ping', n }))) settle(false)
    })
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.options.timers.clear(this.#health)
    this.options.timers.clear(this.#pongTimer)
    for (const settle of [...this.#checks.values()]) settle(false)
    try {
      this.#peer?.close()
    } catch {
      /* already closed */
    }
    this.options.onClose()
  }

  #receive(data: unknown) {
    if (typeof data !== 'string') return
    // Any received frame shows the path is still alive: when a pong shares one ordered channel with many replayed frames it queues behind them, 
    // so arriving late must not be judged as dead. Pong is only the fallback when there are no other frames.
    this.#awaiting = undefined
    this.#misses = 0
    this.options.timers.clear(this.#pongTimer)
    if (data.startsWith('{"t":"pong"')) {
      const header = decodeFrame(data)?.header
      if (header?.t === 'pong') {
        this.#checks.get(header.n)?.(true)
        return
      }
    }
    this.options.onFrame(data)
  }

  #heartbeat() {
    this.#health = this.options.timers.set(() => {
      if (this.#closed) return
      this.#probe()
      this.#heartbeat()
    }, P2P_HEALTH_MS)
  }

  #probe() {
    if (this.#awaiting !== undefined) return
    const n = ++this.#ping
    this.#awaiting = n
    if (!this.send('ctl', encodeFrame({ t: 'ping', n }))) return
    this.#pongTimer = this.options.timers.set(() => {
      if (this.#awaiting !== n) return
      this.#awaiting = undefined
      // One miss triggers an immediate re-probe; two consecutive misses mean the path is dead, so go back to Cloudflare.
      if (++this.#misses >= 2) this.close()
      else this.#probe()
    }, P2P_PONG_MS)
  }
}
