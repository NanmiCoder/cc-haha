import { encodeFrame, decodeFrame, type P2PChannel } from './frames'

/** 只用到的那一小部分 WebRTC，原生库和测试替身都按它来。 */
export type RtcChannel = {
  readonly readyState: string
  send(text: string): void
  close(): void
  on(event: 'open' | 'close', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
}
export type RtcPeer = {
  createChannel(label: P2PChannel, id: number): RtcChannel
  /** 建 offer 并设为本地描述，返回 SDP。 */
  createOffer(): Promise<string>
  setAnswer(sdp: string): Promise<void>
  addCandidate(candidate: string): Promise<void>
  /** null 表示收集完了。 */
  onCandidate(listener: (candidate: string | null) => void): void
  onState(listener: (state: string) => void): void
  /** 选中的候选对两端都是内网地址时是 lan。 */
  selectedPath(): Promise<'lan' | 'direct'>
  close(): void
}
export type RtcFactory = (config: { iceServers: unknown[] }) => RtcPeer
/** 电脑的直连信息：开没开、用哪些 STUN 服务器、收集候选等多久。 */
export type P2PInfo = { available: boolean; iceServers: unknown[]; gatherMs?: number }
export type Signaling = {
  info(): Promise<P2PInfo>
  offer(body: { v: 1; sdp: string; candidates: string[]; complete: boolean }): Promise<{ peerId: string; sdp: string; candidates: string[]; complete: boolean }>
  candidates(body: { peerId: string; candidates: string[]; complete: boolean }): Promise<{ candidates: string[]; complete: boolean }>
}
type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }

/** 协商加通道打开的总时限：超时就继续走 Cloudflare。 */
export const P2P_CONNECT_MS = 8000
export const P2P_HEALTH_MS = 5000
export const P2P_PONG_MS = 1500

export class P2PUnavailable extends Error {}

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:)/i
/** 选中的候选对两端都是内网地址：同一局域网。 */
export function classifyPath(local?: string, remote?: string): 'lan' | 'direct' {
  return local && remote && PRIVATE.test(local) && PRIVATE.test(remote) ? 'lan' : 'direct'
}

/**
 * 一条到电脑的直连。先经 Cloudflare 交换 offer/answer（收集候选最多 gatherMs，
 * 晚到的再补），两条通道都打开才算连上；之后每 5 秒探一次，连续两次没回音
 * （其间也没收到任何别的帧）就断开。
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
  /** 正在等自己那个 pong 的确认（见 `check`），按 ping 序号。 */
  #checks = new Map<number, (alive: boolean) => void>()

  constructor(
    private options: {
      rtc: RtcFactory
      signaling: Signaling
      timers: Timers
      /** 一帧从电脑来（不含心跳）。 */
      onFrame(text: string): void
      /** 直连断了（只调一次）。 */
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
      // 网络抖动：先探一次，不急着断。
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
      // 两边还没收集完就在后台互相补发，直到都收集完或通道打开；连上不等它。
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
        // 补发失败不算失败：已有的候选可能已经够连上，连不上由总时限收尾。
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
   * 这条路眼下还通不通（回到前台时问）：发一个 ping，限时内等到它自己的 pong 才算通。
   * 挂起期间压在缓冲里的旧帧、之前心跳的 pong 只能说明那时还通，不算数。
   * 不通也不在这里断开，由调用方决定。
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
    // 收到任何一帧都说明这条路还通：pong 和大量补发帧挤在同一条有序通道里时会排在后面，
    // 不能因为它晚到就判断开。pong 只是没有别的帧时的兜底。
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
      // 漏了一次马上再探；连续两次没回音，这条路就不通了，回 Cloudflare。
      if (++this.#misses >= 2) this.close()
      else this.#probe()
    }, P2P_PONG_MS)
  }
}
