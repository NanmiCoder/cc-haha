import { describe, expect, test } from 'bun:test'
import { decodeFrame, encodeFrame } from './frames'
import { FakeTimers, fakeRtc } from './fakeRtc'
import { P2P_CONNECT_MS, P2P_HEALTH_MS, P2P_PONG_MS, P2PPeer, P2PUnavailable, type Signaling } from './peer'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function setup(signaling: Partial<Signaling> = {}, rtcOptions = {}) {
  const timers = new FakeTimers()
  const rtc = fakeRtc(rtcOptions)
  const frames: string[] = []
  let closes = 0
  const offers: unknown[] = []
  const peer = new P2PPeer({
    rtc: rtc.factory,
    timers,
    signaling: {
      info: async () => ({ available: true, iceServers: [{ urls: ['stun:fixture'] }], gatherMs: 800 }),
      offer: async (body) => { offers.push(body); return { peerId: 'p1', sdp: 'v=0 answer', candidates: ['remote-1'], complete: true } },
      candidates: async () => ({ candidates: [], complete: true }),
      ...signaling,
    },
    onFrame: (text) => frames.push(text),
    onClose: () => closes++,
  })
  return { peer, timers, rtc, frames, offers, closes: () => closes }
}

describe('direct connection to the computer', () => {
  test('offers with gathered candidates, applies the answer and opens both channels', async () => {
    const f = setup()
    const connected = f.peer.connect()
    await flush()
    const path = await connected
    expect(path).toBe('lan')
    const fake = f.rtc.peers[0]!
    expect(fake.config).toEqual({ iceServers: [{ urls: ['stun:fixture'] }] })
    expect(f.offers).toEqual([{ v: 1, sdp: 'v=0 offer', candidates: [], complete: true }])
    expect(fake.answers).toEqual(['v=0 answer'])
    expect(fake.added).toEqual(['remote-1'])
    expect(f.peer.open).toBe(true)
  })

  test('a computer with direct connections off is reported as unavailable', async () => {
    const f = setup({ info: async () => ({ available: false, iceServers: [] }) })
    await expect(f.peer.connect()).rejects.toBeInstanceOf(P2PUnavailable)
  })

  test('channels that never open give up in time and close the peer', async () => {
    const f = setup({}, { openOnAnswer: false })
    const connected = f.peer.connect()
    await flush()
    f.timers.advance(P2P_CONNECT_MS)
    await expect(connected).rejects.toThrow('timed out')
    expect(f.rtc.peers[0]!.closed).toBe(true)
  })

  test('frames reach the tunnel; pings are answered by the computer and kept out of it', async () => {
    const f = setup()
    const connected = f.peer.connect()
    await flush()
    await connected
    const ctl = f.rtc.peers[0]!.channels.ctl!
    ctl.fire('message', encodeFrame({ t: 'wsa', s: 1 }))
    expect(f.frames).toHaveLength(1)
    f.timers.advance(P2P_HEALTH_MS)
    const ping = decodeFrame(ctl.sent.at(-1))!.header as { t: string; n: number }
    expect(ping.t).toBe('ping')
    ctl.fire('message', encodeFrame({ t: 'pong', n: ping.n }))
    f.timers.advance(P2P_PONG_MS)
    expect(f.frames).toHaveLength(1)
    expect(f.closes()).toBe(0)
  })

  test('two unanswered pings in a row close the connection within a few seconds', async () => {
    const f = setup()
    const connected = f.peer.connect()
    await flush()
    await connected
    f.timers.advance(P2P_HEALTH_MS)
    f.timers.advance(P2P_PONG_MS)
    expect(f.closes()).toBe(0)
    f.timers.advance(P2P_PONG_MS)
    expect(f.closes()).toBe(1)
    expect(f.peer.open).toBe(false)
  })

  test('frames still arriving prove the path is alive even when the pong is stuck behind a large replay', async () => {
    const f = setup()
    const connected = f.peer.connect()
    await flush()
    await connected
    const ctl = f.rtc.peers[0]!.channels.ctl!
    f.timers.advance(P2P_HEALTH_MS)
    f.timers.advance(1000)
    ctl.fire('message', encodeFrame({ t: 'wsm', s: 1, fin: true }, 'replayed frame'))
    f.timers.advance(1000)
    ctl.fire('message', encodeFrame({ t: 'wsm', s: 1, fin: true }, 'replayed frame'))
    f.timers.advance(1000)
    expect(f.closes()).toBe(0)
    expect(f.frames).toHaveLength(2)
    // Real silence is still noticed within a few seconds.
    f.timers.advance(P2P_HEALTH_MS + 2 * P2P_PONG_MS)
    expect(f.closes()).toBe(1)
  })

  test('a check counts only its own pong: frames buffered while the phone slept do not prove the path is alive now', async () => {
    const f = setup()
    const connected = f.peer.connect()
    await flush()
    await connected
    const ctl = f.rtc.peers[0]!.channels.ctl!
    // A heartbeat ping went out just before the phone was suspended.
    f.timers.advance(P2P_HEALTH_MS)
    const before = decodeFrame(ctl.sent.at(-1))!.header as { t: string; n: number }
    let settled: boolean | undefined
    const checked = f.peer.check(P2P_PONG_MS)
    void checked.then((alive) => { settled = alive })
    const ping = decodeFrame(ctl.sent.at(-1))!.header as { t: string; n: number }
    expect(ping.t).toBe('ping')
    expect(ping.n).not.toBe(before.n)
    // What was waiting in the buffers arrives first on wake-up.
    ctl.fire('message', encodeFrame({ t: 'pong', n: before.n }))
    ctl.fire('message', encodeFrame({ t: 'wsm', s: 1, fin: true }, 'buffered while asleep'))
    await flush()
    expect(settled).toBeUndefined()
    ctl.fire('message', encodeFrame({ t: 'pong', n: ping.n }))
    expect(await checked).toBe(true)
  })

  test('a check with no answer in time fails without closing; a closed connection fails it at once', async () => {
    const f = setup()
    const connected = f.peer.connect()
    await flush()
    await connected
    let settled: boolean | undefined
    const silent = f.peer.check(P2P_PONG_MS)
    void silent.then((alive) => { settled = alive })
    f.timers.advance(P2P_PONG_MS - 1)
    await flush()
    expect(settled).toBeUndefined()
    f.timers.advance(1)
    expect(await silent).toBe(false)
    // What to do about it is the caller's decision.
    expect(f.closes()).toBe(0)
    expect(f.peer.open).toBe(true)
    const cut = f.peer.check(P2P_PONG_MS)
    f.peer.close()
    expect(await cut).toBe(false)
    expect(await f.peer.check(P2P_PONG_MS)).toBe(false)
  })

  test('an ICE failure closes the connection', async () => {
    const f = setup()
    const connected = f.peer.connect()
    await flush()
    await connected
    f.rtc.peers[0]!.emitState('failed')
    expect(f.closes()).toBe(1)
  })
})
