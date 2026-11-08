import { describe, expect, test } from 'bun:test'
import { P2PBroker, P2PError, p2pStateDiagnostic, type P2PStateEvent } from './broker.js'
import type { TunnelGateway } from './mux.js'

const gateway: TunnelGateway = {
  fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
  socketHandlers: { open() {}, message() {}, close() {} },
  deviceIdFor: () => 'phone',
  publicUrl: () => 'https://desk.example.test',
}

/** A fake Electron endpoint: records what the broker sends and can answer offers. */
function endpoint() {
  const lines: string[] = []
  return {
    lines,
    closed: undefined as number | undefined,
    send(text: string) { lines.push(text) },
    close(code?: number) { this.closed = code },
    controls() { return lines.filter(line => line.startsWith('#')).map(line => JSON.parse(line.slice(1)) as Record<string, unknown>) },
  }
}

function setup(limits = {}) {
  const states: string[] = []
  const broker = new P2PBroker({ gateway: () => gateway, limits, onState: event => states.push(`${event.state}:${event.path ?? ''}`) })
  return { broker, states }
}

async function connect(broker: P2PBroker, ep: ReturnType<typeof endpoint>, deviceId = 'phone') {
  const pending = broker.offer(deviceId, { sdp: 'v=0 offer', candidates: ['candidate:1 1 udp 1 192.168.1.5 5000 typ host'], complete: false })
  await Promise.resolve()
  const offer = ep.controls().filter(message => message.type === 'offer').at(-1)!
  broker.receive(ep, '#' + JSON.stringify({ type: 'answer', peerId: offer.peerId, sdp: 'v=0 answer', candidates: [], complete: false }))
  return { answer: await pending, offer }
}

describe('P2P broker', () => {
  test('without a desktop endpoint an offer is refused as unavailable', async () => {
    const { broker } = setup()
    await expect(broker.offer('phone', { sdp: 'v=0' })).rejects.toMatchObject({ status: 503, code: 'P2P_UNAVAILABLE' })
  })

  test('relays an offer to the endpoint and returns its answer with the ICE servers it was given', async () => {
    const { broker } = setup()
    const ep = endpoint()
    broker.attachEndpoint(ep)
    const { answer, offer } = await connect(broker, ep)
    expect(offer).toMatchObject({ sdp: 'v=0 offer', candidates: ['candidate:1 1 udp 1 192.168.1.5 5000 typ host'], complete: false })
    expect(offer.iceServers).toEqual(broker.iceServers())
    expect(answer).toEqual({ peerId: offer.peerId as string, sdp: 'v=0 answer', candidates: [], complete: false })
  })

  test('an endpoint that does not answer in time fails the offer and forgets the peer', async () => {
    const { broker } = setup({ answerMs: 10 })
    broker.attachEndpoint(endpoint())
    await expect(broker.offer('phone', { sdp: 'v=0' })).rejects.toMatchObject({ status: 504, code: 'P2P_TIMEOUT' })
    expect(broker.peerCount).toBe(0)
  })

  test('candidates trickle both ways; a long poll wakes when the endpoint finishes gathering', async () => {
    const { broker } = setup({ candidatePollMs: 5000 })
    const ep = endpoint()
    broker.attachEndpoint(ep)
    const { answer } = await connect(broker, ep)
    const poll = broker.candidates('phone', { peerId: answer.peerId, candidates: ['candidate:2 1 udp 1 10.0.0.2 5001 typ host'], complete: true })
    await Promise.resolve()
    expect(ep.controls().at(-1)).toEqual({ type: 'candidates', peerId: answer.peerId, candidates: ['candidate:2 1 udp 1 10.0.0.2 5001 typ host'], complete: true })
    broker.receive(ep, '#' + JSON.stringify({ type: 'candidates', peerId: answer.peerId, candidates: ['candidate:3 1 udp 1 10.0.0.9 6000 typ host'], complete: true }))
    expect(await poll).toEqual({ candidates: ['candidate:3 1 udp 1 10.0.0.9 6000 typ host'], complete: true })
  })

  test('a peer belongs to the device that opened it', async () => {
    const { broker } = setup()
    const ep = endpoint()
    broker.attachEndpoint(ep)
    const { answer } = await connect(broker, ep, 'phone-a')
    await expect(broker.candidates('phone-b', { peerId: answer.peerId, candidates: [] })).rejects.toBeInstanceOf(P2PError)
  })

  test('caps peers per device by closing the oldest', async () => {
    const { broker } = setup({ peersPerDevice: 2 })
    const ep = endpoint()
    broker.attachEndpoint(ep)
    const first = await connect(broker, ep)
    await connect(broker, ep)
    await connect(broker, ep)
    expect(broker.peerCount).toBe(2)
    expect(ep.controls()).toContainEqual({ type: 'close', peerId: first.answer.peerId })
  })

  test('revoking a device closes its peers; a replaced endpoint closes everything', async () => {
    const { broker, states } = setup()
    const ep = endpoint()
    broker.attachEndpoint(ep)
    const a = await connect(broker, ep, 'phone-a')
    await connect(broker, ep, 'phone-b')
    broker.receive(ep, '#' + JSON.stringify({ type: 'state', peerId: a.answer.peerId, state: 'open', path: 'lan' }))
    broker.closeDevice('phone-a')
    expect(broker.peerCount).toBe(1)
    expect(states).toEqual(['open:lan', 'closed:lan'])
    const next = endpoint()
    broker.attachEndpoint(next)
    expect(ep.closed).toBe(4000)
    expect(broker.peerCount).toBe(0)
  })

  test('path changes reach diagnostics as a label, never an address', async () => {
    const events: P2PStateEvent[] = []
    const broker = new P2PBroker({ gateway: () => gateway, onState: event => events.push(event) })
    const ep = endpoint()
    broker.attachEndpoint(ep)
    const a = await connect(broker, ep, 'phone-a')
    const b = await connect(broker, ep, 'phone-b')
    broker.receive(ep, '#' + JSON.stringify({ type: 'state', peerId: a.answer.peerId, state: 'open', path: 'lan' }))
    // An endpoint that reports something other than a path label (an address here) is not repeated.
    broker.receive(ep, '#' + JSON.stringify({ type: 'state', peerId: b.answer.peerId, state: 'open', path: '192.168.1.5:5000' }))
    broker.closeDevice('phone-a')
    expect(events.map(event => [event.state, event.path])).toEqual([['open', 'lan'], ['open', undefined], ['closed', 'lan']])
    const diagnostics = events.map(p2pStateDiagnostic)
    expect(diagnostics[0]).toEqual({
      type: 'p2p_path_changed',
      severity: 'info',
      summary: 'Direct connection open (lan)',
      details: { state: 'open', path: 'lan', peerId: a.answer.peerId },
    })
    expect(diagnostics[2]).toMatchObject({ type: 'p2p_path_changed', severity: 'info', summary: 'Direct connection closed' })
    expect(JSON.stringify(diagnostics)).not.toContain('192.168')
    expect(JSON.stringify(diagnostics)).not.toContain('phone-')
  })

  test('rejects oversized offers and too many candidates', async () => {
    const { broker } = setup()
    broker.attachEndpoint(endpoint())
    await expect(broker.offer('phone', { sdp: 'x'.repeat(17 * 1024) })).rejects.toMatchObject({ status: 400 })
    await expect(broker.offer('phone', { sdp: 'v=0', candidates: Array.from({ length: 33 }, () => 'c') })).rejects.toMatchObject({ status: 400 })
  })

  test('data lines reach the peer and its replies go back through the endpoint', async () => {
    const { broker } = setup()
    const ep = endpoint()
    broker.attachEndpoint(ep)
    const { answer } = await connect(broker, ep)
    broker.receive(ep, `${answer.peerId}|ctl|{"t":"ping","n":7}\n`)
    expect(ep.lines.at(-1)).toBe(`${answer.peerId}|ctl|{"t":"pong","n":7}\n`)
    // Lines from a stale endpoint are ignored.
    const stale = endpoint()
    broker.receive(stale, `${answer.peerId}|ctl|{"t":"ping","n":8}\n`)
    expect(ep.lines.at(-1)).toBe(`${answer.peerId}|ctl|{"t":"pong","n":7}\n`)
  })
})
