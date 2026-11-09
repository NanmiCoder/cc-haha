import { describe, expect, test } from 'vitest'
import { classifyPath, HIGH_WATER, installP2PHost, QUEUE_LIMIT, startP2PHost, type HostEnvironment } from './hostPage'

function fakeChannel(label: string) {
  return {
    label, readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0, sent: [] as string[],
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onbufferedamountlow: null as (() => void) | null,
    onclose: null as (() => void) | null,
    send(data: string) { this.sent.push(data) },
    close() {},
  }
}

function environment() {
  const lines: string[] = []
  const link = {
    readyState: 0,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    send(data: string) { lines.push(data) },
    close() {},
  }
  const peers: Array<ReturnType<typeof fakePeer>> = []
  const timers: Array<() => void> = []
  function fakePeer() {
    const channels: Record<string, ReturnType<typeof fakeChannel>> = {}
    const added: string[] = []
    const peer = {
      connectionState: 'new', localDescription: null as { sdp: string } | null,
      onicecandidate: null as ((event: { candidate: { candidate: string } | null }) => void) | null,
      onconnectionstatechange: null as (() => void) | null,
      channels, added, closed: false, remote: '',
      createDataChannel(label: string) { channels[label] = fakeChannel(label); return channels[label] },
      async setRemoteDescription(description: { sdp: string }) { peer.remote = description.sdp },
      async createAnswer() { return { type: 'answer' as const, sdp: 'v=0 answer' } },
      async setLocalDescription(description: { sdp: string }) { peer.localDescription = { sdp: description.sdp + ' with candidates' } },
      async addIceCandidate(candidate: { candidate: string }) { added.push(candidate.candidate) },
      async getStats() {
        const reports = new Map<string, Record<string, unknown>>([
          ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'l', remoteCandidateId: 'r' }],
          ['l', { address: '192.168.1.10' }],
          ['r', { address: '192.168.1.20' }],
        ])
        return reports
      },
      close() { peer.closed = true },
    }
    return peer
  }
  const env: HostEnvironment = {
    createPeer: () => { const peer = fakePeer(); peers.push(peer); return peer as never },
    connect: () => link as never,
    setTimer: (callback) => { timers.push(callback); return timers.length },
    clearTimer: () => {},
  }
  const controls = () => lines.filter(line => line.startsWith('#')).map(line => JSON.parse(line.slice(1)) as Record<string, unknown>)
  return { env, link, lines, peers, timers, controls }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('desktop P2P endpoint', () => {
  test('answers an offer with gathered candidates, then trickles the late ones', async () => {
    const f = environment()
    startP2PHost('ws://127.0.0.1:1/x', f.env)
    f.link.readyState = 1
    f.link.onopen!()
    f.link.onmessage!({ data: '#' + JSON.stringify({ type: 'offer', peerId: 'p1', sdp: 'v=0 offer', candidates: ['cand-a'], iceServers: [{ urls: ['stun:x'] }] }) })
    await flush()
    const peer = f.peers[0]!
    expect(peer.remote).toBe('v=0 offer')
    expect(peer.added).toEqual(['cand-a'])
    peer.onicecandidate!({ candidate: { candidate: 'host-1' } })
    expect(f.controls().some(message => message.type === 'answer')).toBe(false)
    f.timers.at(-1)!()
    await flush()
    expect(f.controls().find(message => message.type === 'answer')).toEqual({ type: 'answer', peerId: 'p1', sdp: 'v=0 answer with candidates', candidates: ['host-1'], complete: false })
    peer.onicecandidate!({ candidate: { candidate: 'srflx-1' } })
    peer.onicecandidate!({ candidate: null })
    expect(f.controls().slice(-2)).toEqual([
      { type: 'candidates', peerId: 'p1', candidates: ['srflx-1'], complete: false },
      { type: 'candidates', peerId: 'p1', candidates: [], complete: true },
    ])
    f.link.onmessage!({ data: '#' + JSON.stringify({ type: 'candidates', peerId: 'p1', candidates: ['cand-b'] }) })
    await flush()
    expect(peer.added).toEqual(['cand-a', 'cand-b'])
  })

  test('relays frames both ways and reports flow control and the path', async () => {
    const f = environment()
    startP2PHost('ws://127.0.0.1:1/x', f.env)
    f.link.readyState = 1
    f.link.onmessage!({ data: '#' + JSON.stringify({ type: 'offer', peerId: 'p1', sdp: 'v=0', candidates: [] }) })
    await flush()
    const peer = f.peers[0]!
    peer.onicecandidate!({ candidate: null })
    await flush()
    peer.channels.ctl!.onmessage!({ data: '{"t":"ping","n":1}\n' })
    expect(f.lines.at(-1)).toBe('p1|ctl|{"t":"ping","n":1}\n')
    f.link.onmessage!({ data: 'p1|bulk|{"t":"res"}\npayload' })
    expect(peer.channels.bulk!.sent).toEqual(['{"t":"res"}\npayload'])
    peer.channels.bulk!.bufferedAmount = HIGH_WATER + 1
    f.link.onmessage!({ data: 'p1|bulk|more' })
    expect(f.controls().at(-1)).toEqual({ type: 'flow', peerId: 'p1', channel: 'bulk', paused: true })
    peer.channels.bulk!.bufferedAmount = 0
    peer.channels.bulk!.onbufferedamountlow!()
    expect(peer.channels.bulk!.sent).toEqual(['{"t":"res"}\npayload', 'more'])
    expect(f.controls().at(-1)).toEqual({ type: 'flow', peerId: 'p1', channel: 'bulk', paused: false })
    peer.connectionState = 'connected'
    peer.onconnectionstatechange!()
    await flush()
    expect(f.controls().at(-1)).toEqual({ type: 'state', peerId: 'p1', state: 'open', path: 'lan' })
    peer.connectionState = 'failed'
    peer.onconnectionstatechange!()
    expect(peer.closed).toBe(true)
    expect(f.controls().at(-1)).toEqual({ type: 'state', peerId: 'p1', state: 'closed' })
  })

  test('losing the server closes every peer and reconnects with backoff', async () => {
    const f = environment()
    startP2PHost('ws://127.0.0.1:1/x', f.env)
    f.link.readyState = 1
    f.link.onmessage!({ data: '#' + JSON.stringify({ type: 'offer', peerId: 'p1', sdp: 'v=0', candidates: [] }) })
    await flush()
    f.link.onclose!()
    expect(f.peers[0]!.closed).toBe(true)
    expect(f.timers.length).toBeGreaterThan(0)
  })

  async function openPeer() {
    const f = environment()
    startP2PHost('ws://127.0.0.1:1/x', f.env)
    f.link.readyState = 1
    f.link.onmessage!({ data: '#' + JSON.stringify({ type: 'offer', peerId: 'p1', sdp: 'v=0', candidates: [] }) })
    await flush()
    const peer = f.peers[0]!
    peer.onicecandidate!({ candidate: null })
    await flush()
    const bulk = peer.channels.bulk!
    const flows = () => f.controls().filter(message => message.type === 'flow')
    const closed = () => f.controls().filter(message => message.type === 'state' && message.state === 'closed')
    return { f, peer, bulk, flows, closed }
  }

  test('a paused channel holds frames locally and releases them in order once it drains', async () => {
    const { f, bulk, flows } = await openPeer()
    bulk.bufferedAmount = HIGH_WATER + 1
    f.link.onmessage!({ data: 'p1|bulk|one' })
    f.link.onmessage!({ data: 'p1|bulk|two' })
    f.link.onmessage!({ data: 'p1|bulk|three' })
    // Nothing more reaches a channel that is already over its high-water mark.
    expect(bulk.sent).toEqual([])
    expect(flows()).toEqual([{ type: 'flow', peerId: 'p1', channel: 'bulk', paused: true }])
    // Draining releases only what fits, and keeps the server paused meanwhile.
    bulk.bufferedAmount = 0
    const send = bulk.send.bind(bulk)
    bulk.send = (data: string) => { send(data); if (data === 'two') bulk.bufferedAmount = HIGH_WATER + 1 }
    bulk.onbufferedamountlow!()
    expect(bulk.sent).toEqual(['one', 'two'])
    expect(flows()).toHaveLength(1)
    f.link.onmessage!({ data: 'p1|bulk|four' })
    expect(bulk.sent).toEqual(['one', 'two'])
    bulk.bufferedAmount = 0
    bulk.onbufferedamountlow!()
    expect(bulk.sent).toEqual(['one', 'two', 'three', 'four'])
    expect(flows().at(-1)).toEqual({ type: 'flow', peerId: 'p1', channel: 'bulk', paused: false })
    f.link.onmessage!({ data: 'p1|bulk|five' })
    expect(bulk.sent.at(-1)).toBe('five')
  })

  test('a peer whose held frames outgrow the queue limit is closed and reported', async () => {
    const { f, peer, bulk, closed } = await openPeer()
    bulk.bufferedAmount = HIGH_WATER + 1
    const frame = 'x'.repeat(1024 * 1024)
    for (let i = 0; i * frame.length <= QUEUE_LIMIT; i++) f.link.onmessage!({ data: `p1|bulk|${frame}` })
    expect(peer.closed).toBe(true)
    expect(closed()).toEqual([{ type: 'state', peerId: 'p1', state: 'closed' }])
    expect(bulk.sent).toEqual([])
  })

  test('a channel that refuses a frame closes its peer instead of dropping it silently', async () => {
    const { f, peer, bulk, closed } = await openPeer()
    bulk.send = () => { throw new Error('RTCDataChannel send queue is full') }
    expect(() => f.link.onmessage!({ data: 'p1|bulk|frame' })).not.toThrow()
    expect(peer.closed).toBe(true)
    expect(closed()).toEqual([{ type: 'state', peerId: 'p1', state: 'closed' }])
  })

  test('the hidden window keeps the running endpoint so the desktop can stop it gracefully', () => {
    const target: Parameters<typeof installP2PHost>[0] = {}
    const f = environment()
    const closedLinks: number[] = []
    f.link.close = () => { closedLinks.push(1) }
    installP2PHost(target, f.env)
    const first = target.startP2PHost!('ws://127.0.0.1:1/x')
    expect(target.p2pHost).toBe(first)
    // Starting again (a reload) replaces the old endpoint instead of leaking it.
    const second = target.startP2PHost!('ws://127.0.0.1:1/x')
    expect(closedLinks).toHaveLength(1)
    expect(target.p2pHost).toBe(second)
  })

  test('stopping closes every peer connection so phones notice immediately', async () => {
    const f = environment()
    const host = startP2PHost('ws://127.0.0.1:1/x', f.env)
    f.link.readyState = 1
    f.link.onmessage!({ data: '#' + JSON.stringify({ type: 'offer', peerId: 'p1', sdp: 'v=0', candidates: [] }) })
    f.link.onmessage!({ data: '#' + JSON.stringify({ type: 'offer', peerId: 'p2', sdp: 'v=0', candidates: [] }) })
    await flush()
    host.stop()
    expect(f.peers.map(peer => peer.closed)).toEqual([true, true])
    expect(host.peerCount).toBe(0)
  })

  test('classifies private-to-private pairs as LAN and anything else as direct', () => {
    expect(classifyPath('192.168.1.2', '10.0.0.3')).toBe('lan')
    expect(classifyPath('fd12::1', 'fe80::2')).toBe('lan')
    expect(classifyPath('192.168.1.2', '240e::1')).toBe('direct')
    expect(classifyPath(undefined, '10.0.0.1')).toBe('direct')
  })
})
