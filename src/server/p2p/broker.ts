/**
 * Brokers phone ↔ desktop P2P connections without any server of our own.
 *
 * The phone sends its offer through the existing Cloudflare gateway (device
 * authenticated); the broker relays it to the WebRTC endpoint Electron runs in
 * a hidden window (connected over a loopback WebSocket with its own endpoint token) and
 * returns the answer. Once the data channels open, every frame between them
 * crosses this broker, and each peer's multiplexer feeds the gateway.
 *
 * Lines from/to the endpoint:
 * - control: `#` + JSON (`offer`, `answer`, `candidates`, `state`, `flow`, `close`)
 * - data:    `<peerId>|<ctl|bulk>|<frame>`
 */
import { randomBytes } from 'node:crypto'
import { createP2PMux, type P2PMux, type TunnelGateway } from './mux.js'
import type { P2PChannel } from './protocol.js'

export const P2P_LIMITS = {
  peersPerDevice: 2,
  peers: 16,
  idleMs: 10 * 60_000,
  answerMs: 4000,
  candidatePollMs: 3000,
  sdpBytes: 16 * 1024,
  candidates: 32,
  candidateBytes: 512,
}

/**
 * Public STUN servers tried by both ends. No TURN: when no direct path exists
 * the phone simply stays on the Cloudflare tunnel, which is the relay.
 */
export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.miwifi.com:3478', 'stun:stun.l.google.com:19302'] },
]

export class P2PError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** A peer's direct path opened or closed. `path` is a label from the endpoint (`lan`, `direct`). */
export type P2PStateEvent = { deviceId: string; peerId: string; state: 'open' | 'closed'; path?: string }

/**
 * The diagnostics record for a path change: state and path label only. The
 * device is left out, and so are addresses: which IPs connected stays on the
 * two devices.
 */
export function p2pStateDiagnostic(event: P2PStateEvent) {
  return {
    type: 'p2p_path_changed',
    severity: 'info' as const,
    summary: event.state === 'open' ? `Direct connection open (${event.path ?? 'direct'})` : 'Direct connection closed',
    details: { state: event.state, path: event.path, peerId: event.peerId },
  }
}

type Endpoint = { send(text: string): unknown; close(code?: number, reason?: string): void }
type Peer = {
  id: string
  deviceId: string
  mux: P2PMux
  createdAt: number
  activeAt: number
  open: boolean
  path?: string
  answer?: { resolve(value: { sdp: string; candidates: string[]; complete: boolean }): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  /** Endpoint candidates not yet delivered to the phone. */
  outbound: string[]
  outboundComplete: boolean
  delivered: boolean
  waiters: Set<() => void>
}

const candidateList = (value: unknown, limits: typeof P2P_LIMITS) => {
  if (!Array.isArray(value) || value.length > limits.candidates) throw new P2PError(400, 'P2P_BAD_REQUEST', 'Invalid ICE candidates')
  for (const item of value) if (typeof item !== 'string' || item.length > limits.candidateBytes) throw new P2PError(400, 'P2P_BAD_REQUEST', 'Invalid ICE candidate')
  return value as string[]
}

export class P2PBroker {
  private endpoint: Endpoint | null = null
  private peers = new Map<string, Peer>()
  private sweeper: ReturnType<typeof setInterval> | null = null
  private readonly limits: typeof P2P_LIMITS
  private readonly now: () => number

  constructor(private options: {
    gateway: () => TunnelGateway | undefined
    iceServers?: () => typeof DEFAULT_ICE_SERVERS
    limits?: Partial<typeof P2P_LIMITS>
    now?: () => number
    /** Peer path changes, for diagnostics. */
    onState?: (event: P2PStateEvent) => void
  }) {
    this.limits = { ...P2P_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
  }

  get available() { return this.endpoint !== null }
  get peerCount() { return this.peers.size }
  iceServers() { return (this.options.iceServers ?? (() => DEFAULT_ICE_SERVERS))() }

  /** A newer endpoint (a restarted window) replaces the old one and its peers. */
  attachEndpoint(endpoint: Endpoint) {
    if (this.endpoint && this.endpoint !== endpoint) {
      const previous = this.endpoint
      this.closeAll()
      try { previous.close(4000, 'Replaced by a newer endpoint') } catch { /* already closed */ }
    }
    this.endpoint = endpoint
    this.sweeper ??= setInterval(() => this.sweep(), 30_000)
    this.sweeper.unref?.()
  }

  detachEndpoint(endpoint: Endpoint) {
    if (this.endpoint !== endpoint) return
    this.endpoint = null
    this.closeAll()
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }

  /** One line from the endpoint. */
  receive(endpoint: Endpoint, line: string) {
    if (endpoint !== this.endpoint) return
    if (line.startsWith('#')) return this.control(line.slice(1))
    const first = line.indexOf('|')
    const second = first < 0 ? -1 : line.indexOf('|', first + 1)
    if (second < 0) return
    const peer = this.peers.get(line.slice(0, first))
    const channel = line.slice(first + 1, second)
    if (!peer || (channel !== 'ctl' && channel !== 'bulk')) return
    peer.activeAt = this.now()
    peer.mux.receive(channel, line.slice(second + 1))
  }

  async offer(deviceId: string, input: Record<string, unknown>) {
    if (!this.endpoint) throw new P2PError(503, 'P2P_UNAVAILABLE', 'Direct connections are not available on this computer')
    if (typeof input.sdp !== 'string' || input.sdp.length > this.limits.sdpBytes) throw new P2PError(400, 'P2P_BAD_REQUEST', 'Invalid offer')
    const candidates = candidateList(input.candidates ?? [], this.limits)
    const gateway = this.options.gateway()
    if (!gateway) throw new P2PError(503, 'P2P_UNAVAILABLE', 'Remote access is not running')
    const mine = [...this.peers.values()].filter(peer => peer.deviceId === deviceId).sort((a, b) => a.createdAt - b.createdAt)
    while (mine.length >= this.limits.peersPerDevice) this.close(mine.shift()!.id)
    if (this.peers.size >= this.limits.peers) {
      const oldest = [...this.peers.values()].sort((a, b) => a.activeAt - b.activeAt)[0]
      if (oldest) this.close(oldest.id)
    }
    const id = randomBytes(8).toString('hex')
    const peer: Peer = {
      id, deviceId, createdAt: this.now(), activeAt: this.now(), open: false,
      outbound: [], outboundComplete: false, delivered: false, waiters: new Set(),
      mux: createP2PMux({ deviceId, gateway, send: (channel, frame) => this.endpoint?.send(`${id}|${channel}|${frame}`) }),
    }
    this.peers.set(id, peer)
    const answer = new Promise<{ sdp: string; candidates: string[]; complete: boolean }>((resolve, reject) => {
      peer.answer = {
        resolve, reject,
        timer: setTimeout(() => {
          peer.answer = undefined
          this.close(id)
          reject(new P2PError(504, 'P2P_TIMEOUT', 'The computer did not answer in time'))
        }, this.limits.answerMs),
      }
    })
    this.endpoint.send('#' + JSON.stringify({ type: 'offer', peerId: id, sdp: input.sdp, candidates, complete: input.complete === true, iceServers: this.iceServers() }))
    const result = await answer
    return { peerId: id, ...result }
  }

  /** Trickles the phone's late candidates and long-polls for the endpoint's. */
  async candidates(deviceId: string, input: Record<string, unknown>) {
    const peer = typeof input.peerId === 'string' ? this.peers.get(input.peerId) : undefined
    if (!peer || peer.deviceId !== deviceId) throw new P2PError(404, 'P2P_UNKNOWN_PEER', 'Unknown direct connection')
    const candidates = candidateList(input.candidates ?? [], this.limits)
    peer.activeAt = this.now()
    if (candidates.length || input.complete === true) {
      this.endpoint?.send('#' + JSON.stringify({ type: 'candidates', peerId: peer.id, candidates, complete: input.complete === true }))
    }
    if (!peer.outbound.length && !peer.outboundComplete) {
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); peer.waiters.delete(wake); resolve() }
        const timer = setTimeout(wake, this.limits.candidatePollMs)
        peer.waiters.add(wake)
      })
    }
    const out = peer.outbound.splice(0)
    return { candidates: out, complete: peer.outboundComplete }
  }

  /** Ends every peer of a device (revoked, expired). */
  closeDevice(deviceId: string) {
    for (const peer of [...this.peers.values()]) if (peer.deviceId === deviceId) this.close(peer.id)
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.close(id)
  }

  status() {
    return { available: this.available, peers: this.peers.size, open: [...this.peers.values()].filter(peer => peer.open).length }
  }

  private close(id: string) {
    const peer = this.peers.get(id)
    if (!peer) return
    this.peers.delete(id)
    if (peer.answer) {
      clearTimeout(peer.answer.timer)
      peer.answer.reject(new P2PError(503, 'P2P_CLOSED', 'The direct connection closed'))
    }
    for (const wake of [...peer.waiters]) wake()
    peer.mux.close()
    try { this.endpoint?.send('#' + JSON.stringify({ type: 'close', peerId: id })) } catch { /* endpoint gone */ }
    if (peer.open) this.options.onState?.({ deviceId: peer.deviceId, peerId: id, state: 'closed', path: peer.path })
  }

  private sweep() {
    const now = this.now()
    for (const peer of [...this.peers.values()]) if (now - peer.activeAt > this.limits.idleMs) this.close(peer.id)
  }

  private control(text: string) {
    let message: Record<string, unknown>
    try { message = JSON.parse(text) } catch { return }
    const peer = typeof message.peerId === 'string' ? this.peers.get(message.peerId) : undefined
    if (!peer) return
    peer.activeAt = this.now()
    switch (message.type) {
      case 'answer': {
        if (!peer.answer || typeof message.sdp !== 'string') return
        clearTimeout(peer.answer.timer)
        const { resolve } = peer.answer
        peer.answer = undefined
        let candidates: string[] = []
        try { candidates = candidateList(message.candidates ?? [], this.limits) } catch { /* drop bad candidates */ }
        resolve({ sdp: message.sdp, candidates, complete: message.complete === true })
        return
      }
      case 'candidates': {
        try { peer.outbound.push(...candidateList(message.candidates ?? [], this.limits)) } catch { return }
        if (message.complete === true) peer.outboundComplete = true
        for (const wake of [...peer.waiters]) wake()
        return
      }
      case 'state': {
        if (message.state === 'open') {
          peer.open = true
          // A path label only: anything else (an address, say) is not repeated into diagnostics.
          peer.path = typeof message.path === 'string' && /^[a-z-]{1,16}$/.test(message.path) ? message.path : undefined
          this.options.onState?.({ deviceId: peer.deviceId, peerId: peer.id, state: 'open', path: peer.path })
        } else if (message.state === 'closed') this.close(peer.id)
        return
      }
      case 'flow': {
        if (message.channel !== 'ctl' && message.channel !== 'bulk') return
        peer.mux.setPaused(message.channel as P2PChannel, message.paused === true)
        return
      }
      default:
        return
    }
  }
}
