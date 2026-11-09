/**
 * The desktop end of the phone's P2P data channels.
 *
 * Runs inside a hidden, sandboxed Electron window so it can use Chromium's
 * WebRTC (the same libwebrtc the phone uses: mature ICE, IPv6, network-change
 * handling) without any native module. It only pipes: offers and candidates
 * arrive from the local server over a loopback WebSocket, and every data
 * channel frame is relayed verbatim as `<peerId>|<ctl|bulk>|<frame>`. The
 * server terminates the protocol and applies all authentication.
 */

/** Hold a channel's sends once this much is queued; resume below the low mark. */
export const HIGH_WATER = 1024 * 1024
export const LOW_WATER = 256 * 1024
/**
 * Frames (in characters) a paused channel may hold here while the server
 * catches up with its pause; a peer that outgrows it is closed rather than
 * letting Chromium's own send buffer overflow and drop the channel.
 */
export const QUEUE_LIMIT = 32 * 1024 * 1024
/** How long to gather candidates before answering; late ones trickle in the background. */
export const GATHER_MS = 300

type Channel = {
  readonly label: string
  readyState: string
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  onmessage: ((event: { data: unknown }) => void) | null
  onbufferedamountlow: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(): void
}
type Peer = {
  connectionState: string
  localDescription: { sdp: string } | null
  onicecandidate: ((event: { candidate: { candidate: string } | null }) => void) | null
  onconnectionstatechange: (() => void) | null
  createDataChannel(label: string, options: { negotiated: true; id: number; ordered: true }): Channel
  setRemoteDescription(description: { type: 'offer'; sdp: string }): Promise<void>
  createAnswer(): Promise<{ type: 'answer'; sdp: string }>
  setLocalDescription(description: { type: 'answer'; sdp: string }): Promise<void>
  addIceCandidate(candidate: { candidate: string; sdpMLineIndex: number }): Promise<void>
  getStats(): Promise<Map<string, Record<string, unknown>> | { forEach(callback: (value: Record<string, unknown>, key: string) => void): void; get(key: string): Record<string, unknown> | undefined }>
  close(): void
}
type Link = {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(): void
}
export type HostEnvironment = {
  createPeer(config: { iceServers: unknown[] }): Peer
  connect(endpoint: string): Link
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:)/i

/** `lan` when both ends of the selected pair are on private addresses. */
export function classifyPath(local?: string, remote?: string) {
  if (!local || !remote) return 'direct'
  return PRIVATE.test(local) && PRIVATE.test(remote) ? 'lan' : 'direct'
}

type Label = 'ctl' | 'bulk'
type Entry = {
  peer: Peer
  channels: Record<Label, Channel>
  paused: Record<Label, boolean>
  /** Frames held while a channel is paused, in order, and their total length. */
  held: Record<Label, string[]>
  heldSize: Record<Label, number>
  opened: boolean
}
export type P2PHostHandle = { stop(): void; readonly peerCount: number }

export function startP2PHost(endpoint: string, env: HostEnvironment): P2PHostHandle {
  const peers = new Map<string, Entry>()
  let link: Link | null = null
  let retry: unknown
  let stopped = false
  let backoff = 500

  const control = (message: Record<string, unknown>) => {
    if (link?.readyState === 1) link.send('#' + JSON.stringify(message))
  }

  const closePeer = (id: string, notify: boolean) => {
    const entry = peers.get(id)
    if (!entry) return
    peers.delete(id)
    try { entry.peer.close() } catch { /* already closed */ }
    if (notify) control({ type: 'state', peerId: id, state: 'closed' })
  }

  const reportPath = async (id: string) => {
    const entry = peers.get(id)
    if (!entry) return
    let path = 'direct'
    try {
      const stats = await entry.peer.getStats()
      let local: string | undefined
      let remote: string | undefined
      stats.forEach((report) => {
        if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || !report.nominated) return
        local = stats.get(String(report.localCandidateId))?.address as string | undefined
        remote = stats.get(String(report.remoteCandidateId))?.address as string | undefined
      })
      path = classifyPath(local, remote)
    } catch { /* keep the generic label */ }
    control({ type: 'state', peerId: id, state: 'open', path })
  }

  const offer = async (message: Record<string, unknown>) => {
    const id = String(message.peerId)
    closePeer(id, false)
    const peer = env.createPeer({ iceServers: Array.isArray(message.iceServers) ? message.iceServers : [] })
    const channels = {
      ctl: peer.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true }),
      bulk: peer.createDataChannel('bulk', { negotiated: true, id: 1, ordered: true }),
    }
    const entry: Entry = {
      peer, channels, opened: false,
      paused: { ctl: false, bulk: false }, held: { ctl: [], bulk: [] }, heldSize: { ctl: 0, bulk: 0 },
    }
    peers.set(id, entry)
    for (const label of ['ctl', 'bulk'] as const) {
      const channel = channels[label]
      channel.bufferedAmountLowThreshold = LOW_WATER
      channel.onmessage = ({ data }) => {
        if (typeof data === 'string' && link?.readyState === 1) link.send(`${id}|${label}|${data}`)
      }
      channel.onbufferedamountlow = () => drain(id, entry, label)
      channel.onclose = () => closePeer(id, true)
    }
    const local: string[] = []
    let answered = false
    let complete = false
    peer.onicecandidate = ({ candidate }) => {
      if (!candidate) complete = true
      else local.push(candidate.candidate)
      if (answered) {
        control({ type: 'candidates', peerId: id, candidates: candidate ? [candidate.candidate] : [], complete })
      }
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected' && !entry.opened) {
        entry.opened = true
        void reportPath(id)
      }
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') closePeer(id, true)
    }
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp: String(message.sdp) })
      for (const candidate of Array.isArray(message.candidates) ? message.candidates : []) {
        await peer.addIceCandidate({ candidate: String(candidate), sdpMLineIndex: 0 }).catch(() => {})
      }
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      // Answer with what gathers quickly; anything later trickles.
      await new Promise<void>((resolve) => {
        if (complete) return resolve()
        const timer = env.setTimer(resolve, GATHER_MS)
        const original = peer.onicecandidate
        peer.onicecandidate = (event) => {
          original?.(event)
          if (!event.candidate) { env.clearTimer(timer); resolve() }
        }
      })
      if (!peers.has(id)) return
      answered = true
      control({ type: 'answer', peerId: id, sdp: peer.localDescription?.sdp ?? answer.sdp, candidates: local.splice(0), complete })
    } catch {
      closePeer(id, true)
    }
  }

  /** A channel that refuses a frame cannot keep the stream intact: end the peer. */
  const transmit = (id: string, channel: Channel, frame: string) => {
    try {
      channel.send(frame)
      return true
    } catch {
      closePeer(id, true)
      return false
    }
  }

  const pause = (id: string, entry: Entry, label: Label) => {
    if (entry.paused[label]) return
    entry.paused[label] = true
    control({ type: 'flow', peerId: id, channel: label, paused: true })
  }

  /** Release held frames while they fit; resume the server only once none are left. */
  const drain = (id: string, entry: Entry, label: Label) => {
    if (peers.get(id) !== entry || !entry.paused[label]) return
    const channel = entry.channels[label]
    const held = entry.held[label]
    while (held.length && channel.bufferedAmount <= HIGH_WATER) {
      const frame = held.shift()!
      entry.heldSize[label] -= frame.length
      if (!transmit(id, channel, frame)) return
    }
    if (held.length) return
    entry.paused[label] = false
    control({ type: 'flow', peerId: id, channel: label, paused: false })
  }

  const relay = (line: string) => {
    const first = line.indexOf('|')
    const second = first < 0 ? -1 : line.indexOf('|', first + 1)
    if (second < 0) return
    const id = line.slice(0, first)
    const entry = peers.get(id)
    const label = line.slice(first + 1, second)
    if (!entry || (label !== 'ctl' && label !== 'bulk')) return
    const channel = entry.channels[label]
    if (channel.readyState !== 'open') return
    const frame = line.slice(second + 1)
    // Frames already in flight when the server paused (or one that would
    // overfill the channel) wait here, in order, until the channel drains.
    if (entry.paused[label] || channel.bufferedAmount > HIGH_WATER) {
      pause(id, entry, label)
      entry.held[label].push(frame)
      entry.heldSize[label] += frame.length
      if (entry.heldSize[label] > QUEUE_LIMIT) closePeer(id, true)
      return
    }
    if (!transmit(id, channel, frame)) return
    if (channel.bufferedAmount > HIGH_WATER) pause(id, entry, label)
  }

  const receive = (data: unknown) => {
    if (typeof data !== 'string') return
    if (!data.startsWith('#')) return relay(data)
    let message: Record<string, unknown>
    try { message = JSON.parse(data.slice(1)) } catch { return }
    const id = typeof message.peerId === 'string' ? message.peerId : ''
    if (message.type === 'offer' && id) void offer(message)
    else if (message.type === 'candidates' && id) {
      const entry = peers.get(id)
      for (const candidate of Array.isArray(message.candidates) ? message.candidates : []) {
        void entry?.peer.addIceCandidate({ candidate: String(candidate), sdpMLineIndex: 0 }).catch(() => {})
      }
    } else if (message.type === 'close' && id) closePeer(id, false)
  }

  const open = () => {
    if (stopped) return
    const current = env.connect(endpoint)
    link = current
    current.onopen = () => {
      backoff = 500
      control({ type: 'hello', v: 1 })
    }
    current.onmessage = ({ data }) => receive(data)
    current.onclose = () => {
      if (link !== current) return
      link = null
      // Without the server nothing can be relayed; phones fall back to Cloudflare.
      for (const id of [...peers.keys()]) closePeer(id, false)
      if (stopped) return
      retry = env.setTimer(open, backoff)
      backoff = Math.min(30_000, backoff * 2)
    }
  }
  open()

  return {
    stop() {
      stopped = true
      env.clearTimer(retry)
      for (const id of [...peers.keys()]) closePeer(id, false)
      link?.close()
      link = null
    },
    get peerCount() { return peers.size },
  }
}

type HostTarget = {
  startP2PHost?: (endpoint: string) => P2PHostHandle
  /** The running endpoint: the desktop stops it (closing every peer) before destroying the window. */
  p2pHost?: P2PHostHandle
}

declare global {
  interface Window {
    startP2PHost?: HostTarget['startP2PHost']
    p2pHost?: HostTarget['p2pHost']
  }
}

export function installP2PHost(target: HostTarget, env: HostEnvironment) {
  target.startP2PHost = (endpoint: string) => {
    target.p2pHost?.stop()
    const host = startP2PHost(endpoint, env)
    target.p2pHost = host
    return host
  }
}

// In the hidden window: wire the real browser primitives.
if (typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined') {
  installP2PHost(window, {
    createPeer: (config) => new RTCPeerConnection(config as RTCConfiguration) as unknown as Peer,
    connect: (url) => new WebSocket(url) as unknown as Link,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
}
