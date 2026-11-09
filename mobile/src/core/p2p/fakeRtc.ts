// Test doubles for the WebRTC surface the P2P code uses (tests only).
import type { RtcChannel, RtcFactory, RtcPeer } from './peer'
import { decodeFrame, encodeFrame, type P2PChannel } from './frames'

export class FakeTimers {
  now = 0
  id = 0
  jobs = new Map<number, { at: number; run: () => void }>()
  set = (run: () => void, ms: number) => {
    this.jobs.set(++this.id, { at: this.now + ms, run })
    return this.id
  }
  clear = (handle: unknown) => {
    this.jobs.delete(handle as number)
  }
  advance(ms: number) {
    const end = this.now + ms
    for (let guard = 0; guard < 1000; guard++) {
      const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.now = next[1].at
      this.jobs.delete(next[0])
      next[1].run()
    }
    this.now = end
  }
}

export class FakeChannel implements RtcChannel {
  readyState = 'connecting'
  sent: string[] = []
  listeners: Record<string, ((data?: unknown) => void)[]> = {}
  /** What the far end does with a frame once it is sent. */
  onSend?: (text: string) => void
  constructor(readonly label: P2PChannel) {}
  send(text: string) {
    if (this.readyState !== 'open') throw new Error('closed')
    this.sent.push(text)
    this.onSend?.(text)
  }
  close() {
    this.readyState = 'closed'
  }
  on(event: string, listener: (data?: unknown) => void) {
    ;(this.listeners[event] ??= []).push(listener)
  }
  fire(event: string, data?: unknown) {
    if (event === 'open') this.readyState = 'open'
    if (event === 'close') this.readyState = 'closed'
    for (const listener of this.listeners[event] ?? []) listener(data)
  }
}

export type FakePeer = RtcPeer & {
  config: { iceServers: unknown[] }
  channels: Partial<Record<P2PChannel, FakeChannel>>
  answers: string[]
  added: string[]
  closed: boolean
  emitCandidate(candidate: string | null): void
  emitState(state: string): void
  openChannels(): void
}

export function fakeRtc(
  options: {
    path?: 'lan' | 'direct'
    openOnAnswer?: boolean
    /** The computer answers pings (a moment later, like a real round trip) while this says so. */
    answerPings?: () => boolean
  } = {}
) {
  const peers: FakePeer[] = []
  const factory: RtcFactory = (config) => {
    const candidateListeners: ((candidate: string | null) => void)[] = []
    const stateListeners: ((state: string) => void)[] = []
    const peer: FakePeer = {
      config,
      channels: {},
      answers: [],
      added: [],
      closed: false,
      createChannel(label) {
        const channel = new FakeChannel(label)
        const answerPings = options.answerPings
        if (label === 'ctl' && answerPings) {
          channel.onSend = (text) => {
            const header = decodeFrame(text)?.header
            if (header?.t === 'ping' && answerPings())
              queueMicrotask(() => channel.fire('message', encodeFrame({ t: 'pong', n: header.n })))
          }
        }
        peer.channels[label] = channel
        return channel
      },
      async createOffer() {
        queueMicrotask(() => peer.emitCandidate(null))
        return 'v=0 offer'
      },
      async setAnswer(sdp) {
        peer.answers.push(sdp)
        if (options.openOnAnswer !== false) queueMicrotask(() => peer.openChannels())
      },
      async addCandidate(candidate) {
        peer.added.push(candidate)
      },
      onCandidate(listener) {
        candidateListeners.push(listener)
      },
      onState(listener) {
        stateListeners.push(listener)
      },
      async selectedPath() {
        return options.path ?? 'lan'
      },
      close() {
        peer.closed = true
      },
      emitCandidate(candidate) {
        for (const listener of candidateListeners) listener(candidate)
      },
      emitState(state) {
        for (const listener of stateListeners) listener(state)
      },
      openChannels() {
        peer.channels.ctl?.fire('open')
        peer.channels.bulk?.fire('open')
      },
    }
    peers.push(peer)
    return peer
  }
  return { factory, peers }
}
