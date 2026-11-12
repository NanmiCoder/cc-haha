import { describe, expect, test } from 'bun:test'
import type { FetchAdapter } from './client'
import {
  BACKGROUND_CLOSE_MS,
  COOLDOWN_MS,
  FOREGROUND_PROBE_MS,
  HostLink,
  hostLinks,
  STALE_AFTER_BACKGROUND_MS,
  UNAVAILABLE_RECHECK_MS,
  UNSUPPORTED_MS,
  UPGRADE_DELAY_MS,
} from './hostLink'
import { decodeFrame, encodeFrame } from './p2p/frames'
import { FakeTimers, fakeRtc } from './p2p/fakeRtc'
import type { SocketLike } from './sessionTransport'
import type { Host } from './types'

const host: Host = { id: 'desk', name: 'Desk', url: 'https://desk.example.test', auth: 'remote' }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const init = (method = 'GET') => ({
  method, headers: {}, signal: new AbortController().signal, redirect: 'error' as const, credentials: 'omit' as const,
})
const INFO = 'GET /api/public-access/p2p'
const OFFER = 'POST /api/public-access/p2p/offer'

function setup(options: { available?: boolean; status?: number; offerStatus?: number; offerCode?: string; rtc?: boolean } = {}) {
  const timers = new FakeTimers()
  /** The computer at the far end of the direct path: answers pings while it is reachable. */
  const computer = { reachable: true }
  const rtc = fakeRtc({ answerPings: () => computer.reachable })
  const cf: string[] = []
  /** What the computer answers on the signaling routes; a test may change it between attempts. */
  const server = { available: options.available ?? true, status: options.status, offerStatus: options.offerStatus, offerCode: options.offerCode }
  const cfFetch: FetchAdapter = async (input, request) => {
    const path = new URL(input).pathname
    cf.push(`${request.method} ${path}`)
    const body = path === '/api/public-access/p2p' ? { v: 1, available: server.available, iceServers: [], gatherMs: 10 }
      : path.endsWith('/offer') ? { peerId: 'p1', sdp: 'v=0 answer', candidates: [], complete: true }
      : path.endsWith('/candidates') ? { candidates: [], complete: true }
      : { via: 'cloudflare' }
    const status =
      path === '/api/public-access/p2p' && server.status ? server.status
      : path.endsWith('/offer') && server.offerStatus ? server.offerStatus
      : 200
    // Failures are shaped the way the gateway sends them (publicAccess.ts p2pRoute).
    const failure = status === 404 ? { error: 'Not found' } : { error: 'Direct connection failed', ...(server.offerCode ? { code: server.offerCode } : {}) }
    return { ok: status < 300, status, url: input, redirected: false, text: async () => JSON.stringify(status < 300 ? body : failure) }
  }
  const cfSockets: string[] = []
  const cfSocket = (socketOptions: { url: string }) => {
    cfSockets.push(socketOptions.url)
    return { readyState: 0 } as unknown as SocketLike
  }
  const link = new HostLink({ host, credential: 'native_fixture', cfFetch, cfSocket, rtc: options.rtc === false ? undefined : rtc.factory, timers, now: () => timers.now })
  const paths: string[] = []
  link.onPathChange((path) => paths.push(path))
  /** Answer the next request sent over the direct path, as the computer would. */
  const answerDirect = (body: string) => {
    const bulk = rtc.peers.at(-1)!.channels.bulk!
    const request = decodeFrame(bulk.sent.at(-1))!.header as { s: number }
    bulk.fire('message', encodeFrame({ t: 'res', s: request.s, st: 200, h: { 'content-type': 'application/json' }, b: 'text', fin: true }, body))
  }
  const upgrade = async () => {
    await link.fetch('https://desk.example.test/api/sessions', init())
    timers.advance(UPGRADE_DELAY_MS)
    await flush()
    timers.advance(10)
    await flush()
  }
  /** Lets the direct path's first failure cooldown run out and the next negotiation finish. */
  const retryAfterLoss = async () => {
    timers.advance(COOLDOWN_MS[0]!)
    await flush()
    timers.advance(10)
    await flush()
  }
  /** Time passing with the computer's answers getting through (unlike one big jump). */
  const elapse = async (ms: number) => {
    for (let passed = 0; passed < ms; passed += 500) {
      timers.advance(Math.min(500, ms - passed))
      await flush()
    }
  }
  const count = (entry: string) => cf.filter((item) => item === entry).length
  return { link, timers, rtc, cf, cfSockets, paths, answerDirect, upgrade, retryAfterLoss, elapse, count, server, computer }
}

describe('connection path to a remote computer', () => {
  test('without native WebRTC everything stays on Cloudflare', async () => {
    const f = setup({ rtc: false })
    await f.link.fetch('https://desk.example.test/api/sessions', init())
    f.timers.advance(60_000)
    await flush()
    expect(f.cf).toEqual(['GET /api/sessions'])
    f.link.socketFactory({ url: 'wss://desk.example.test/ws/s1' })
    expect(f.cfSockets).toHaveLength(1)
  })

  test('starts on Cloudflare, upgrades in the background, then sends requests directly', async () => {
    const f = setup()
    await f.upgrade()
    expect(f.cf).toEqual(['GET /api/sessions', 'GET /api/public-access/p2p', 'POST /api/public-access/p2p/offer'])
    expect(f.link.path).toBe('lan')
    expect(f.paths).toEqual(['lan'])
    const direct = f.link.fetch('https://desk.example.test/api/sessions?limit=5', init())
    await flush()
    f.answerDirect('{"via":"direct"}')
    expect(await (await direct).text()).toBe('{"via":"direct"}')
    expect(f.cf).toHaveLength(3)
    const socket = f.link.socketFactory({ url: 'wss://desk.example.test/ws/s1?stream=x', headers: { Origin: host.url } })
    expect(f.cfSockets).toEqual([])
    expect(decodeFrame(f.rtc.peers[0]!.channels.ctl!.sent.at(-1))!.header).toMatchObject({ t: 'wso', p: '/ws/s1?stream=x' })
    expect(socket.readyState).toBe(0)
  })

  test('losing the direct path falls back quietly, closes its sockets as a drop, and waits before retrying', async () => {
    const f = setup()
    await f.upgrade()
    const socket = f.link.socketFactory({ url: 'wss://desk.example.test/ws/s1' })
    let closed = 0
    socket.onclose = ({ code }) => { closed = code }
    f.rtc.peers[0]!.emitState('failed')
    expect(f.link.path).toBe('cf')
    expect(f.paths).toEqual(['lan', 'cf'])
    expect(closed).toBe(1006)
    await f.link.fetch('https://desk.example.test/api/sessions', init())
    expect(f.cf.at(-1)).toBe('GET /api/sessions')
    const offers = f.cf.filter((entry) => entry.endsWith('/offer')).length
    f.timers.advance(COOLDOWN_MS[0]! - 1)
    await flush()
    expect(f.cf.filter((entry) => entry.endsWith('/offer'))).toHaveLength(offers)
    f.timers.advance(1)
    await flush()
    f.timers.advance(10)
    await flush()
    expect(f.cf.filter((entry) => entry.endsWith('/offer'))).toHaveLength(offers + 1)
  })

  test('an older computer without direct connections is not asked again on every request', async () => {
    const f = setup({ status: 404 })
    await f.upgrade()
    expect(f.link.path).toBe('cf')
    for (let i = 0; i < 3; i++) {
      await f.link.fetch('https://desk.example.test/api/sessions', init())
      f.timers.advance(10 * 60_000)
      await flush()
    }
    expect(f.cf.filter((entry) => entry === 'GET /api/public-access/p2p')).toHaveLength(1)
  })

  test('a network change or coming back retries a failed attempt at once instead of waiting out the cooldown', async () => {
    // A 503 that is not "direct connections are off" (the endpoint dropped the offer) is an ordinary failure.
    const f = setup({ offerStatus: 503, offerCode: 'P2P_CLOSED' })
    await f.upgrade()
    const offers = () => f.count(OFFER)
    expect(offers()).toBe(1)
    f.link.networkChanged()
    f.timers.advance(0)
    await flush()
    expect(offers()).toBe(2)
    f.link.background()
    f.timers.advance(1000)
    f.link.foreground()
    f.timers.advance(0)
    await flush()
    expect(offers()).toBe(3)
    // The computer's direct-connection info is still good after an ordinary failure: asked once.
    expect(f.count(INFO)).toBe(1)
  })

  test('a computer with direct connections off is asked again after a minute, and coming back does not reset that', async () => {
    expect(UNAVAILABLE_RECHECK_MS).toBe(60_000)
    const f = setup({ available: false })
    await f.upgrade()
    const infos = () => f.cf.filter((entry) => entry === 'GET /api/public-access/p2p').length
    expect(infos()).toBe(1)
    f.link.background()
    f.timers.advance(1000)
    f.link.foreground()
    f.link.networkChanged()
    f.timers.advance(0)
    await flush()
    expect(infos()).toBe(1)
    await f.link.fetch('https://desk.example.test/api/sessions', init())
    f.timers.advance(UNAVAILABLE_RECHECK_MS)
    await flush()
    expect(infos()).toBe(2)
  })

  test('an older computer stays unasked even across returns and network changes', async () => {
    const f = setup({ status: 404 })
    await f.upgrade()
    f.link.background()
    f.timers.advance(60_000)
    f.link.foreground()
    f.link.networkChanged()
    await f.link.fetch('https://desk.example.test/api/sessions', init())
    f.timers.advance(60 * 60_000)
    await flush()
    expect(f.cf.filter((entry) => entry === 'GET /api/public-access/p2p')).toHaveLength(1)
  })

  test('a computer removed from the list releases its link and stops negotiating', async () => {
    const f = setup()
    const kept = setup()
    const other: Host = { ...host, id: 'other' }
    const link = hostLinks.for(host, 'native_fixture', () => f.link)
    expect(hostLinks.for(other, 'native_fixture', () => kept.link)).toBe(kept.link)
    // A request schedules an upgrade; the computer is removed before it runs.
    await link.fetch('https://desk.example.test/api/sessions', init())
    hostLinks.retain([other.id])
    expect(hostLinks.get(host)).toBeUndefined()
    expect(hostLinks.get(other)).toBe(kept.link)
    link.foreground()
    link.networkChanged()
    f.timers.advance(60_000)
    await flush()
    expect(f.cf).toEqual(['GET /api/sessions'])
    hostLinks.forget(other.id)
    expect(hostLinks.all()).toEqual([])
  })

  test('a GET whose answer already started is not resent on Cloudflare when the direct path drops', async () => {
    const f = setup()
    await f.upgrade()
    const get = f.link.fetch('https://desk.example.test/api/sessions', init())
    await flush()
    const bulk = f.rtc.peers[0]!.channels.bulk!
    const request = decodeFrame(bulk.sent.at(-1))!.header as { s: number }
    bulk.fire('message', encodeFrame({ t: 'res', s: request.s, st: 200, h: { 'content-type': 'application/json' }, b: 'text', fin: false }, '{"via":'))
    const response = await Promise.race([
      get,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('response not handed over at its headers')), 200)),
    ])
    const body = response.text()
    f.rtc.peers[0]!.emitState('failed')
    await expect(body).rejects.toThrow('Direct connection closed')
    expect(f.cf.filter((entry) => entry === 'GET /api/sessions')).toHaveLength(1)
  })

  test('coming back after a long stay away keeps a direct path that still answers, without renegotiating', async () => {
    const f = setup()
    await f.upgrade()
    f.link.background()
    await f.elapse(STALE_AFTER_BACKGROUND_MS + 5000)
    f.link.foreground()
    expect(f.rtc.peers[0]!.closed).toBe(false)
    expect(f.link.path).toBe('lan')
    // While the answer is on its way: a GET rides the direct path; a POST, which could not be
    // resent if that path turned out dead, goes through Cloudflare.
    const get = f.link.fetch('https://desk.example.test/api/sessions?limit=5', init())
    const post = f.link.fetch('https://desk.example.test/api/sessions', init('POST'))
    expect(await (await post).text()).toBe('{"via":"cloudflare"}')
    f.answerDirect('{"via":"direct"}')
    expect(await (await get).text()).toBe('{"via":"direct"}')
    await flush()
    // Answered: everything goes direct again, on the same connection.
    const direct = f.link.fetch('https://desk.example.test/api/sessions', init('POST'))
    await flush()
    f.answerDirect('{"via":"direct"}')
    expect(await (await direct).text()).toBe('{"via":"direct"}')
    await f.elapse(60_000)
    expect(f.rtc.peers).toHaveLength(1)
    expect(f.rtc.peers[0]!.closed).toBe(false)
    expect(f.paths).toEqual(['lan'])
    expect(f.count(OFFER)).toBe(1)
    expect(f.count('POST /api/sessions')).toBe(1)
  })

  test('coming back to a direct path that no longer answers falls back to Cloudflare and renegotiates at once; nothing waits on it', async () => {
    const f = setup()
    await f.upgrade()
    f.link.background()
    await f.elapse(STALE_AFTER_BACKGROUND_MS + 5000)
    // The path died while the phone slept (a NAT or firewall mapping expired).
    f.computer.reachable = false
    f.link.foreground()
    const get = f.link.fetch('https://desk.example.test/api/sessions', init())
    const post = f.link.fetch('https://desk.example.test/api/sessions', init('POST'))
    const socket = f.link.socketFactory({ url: 'wss://desk.example.test/ws/s1' })
    let closed = 0
    socket.onclose = ({ code }) => { closed = code }
    // The POST never waits on the doubtful path.
    expect(await (await post).text()).toBe('{"via":"cloudflare"}')
    f.timers.advance(FOREGROUND_PROBE_MS - 1)
    await flush()
    expect(f.link.path).toBe('lan')
    expect(f.count('GET /api/sessions')).toBe(1)
    f.timers.advance(1)
    await flush()
    expect(f.link.path).toBe('cf')
    expect(f.rtc.peers[0]!.closed).toBe(true)
    // The GET sent down the dead path is answered through Cloudflare; the socket ends as a drop and resumes there.
    expect(await (await get).text()).toBe('{"via":"cloudflare"}')
    expect(closed).toBe(1006)
    // No failure cooldown: renegotiated straight away.
    f.timers.advance(0)
    await flush()
    f.timers.advance(10)
    await flush()
    expect(f.link.path).toBe('lan')
    expect(f.rtc.peers).toHaveLength(2)
    expect(f.paths).toEqual(['lan', 'cf', 'lan'])
  })

  test('a direct path closed after a minute in the background is renegotiated as soon as the app returns', async () => {
    const f = setup()
    await f.upgrade()
    f.link.background()
    await f.elapse(BACKGROUND_CLOSE_MS)
    expect(f.rtc.peers[0]!.closed).toBe(true)
    expect(f.link.path).toBe('cf')
    await f.elapse(30_000)
    expect(f.count(OFFER)).toBe(1)
    f.link.foreground()
    f.timers.advance(0)
    await flush()
    f.timers.advance(10)
    await flush()
    expect(f.link.path).toBe('lan')
    expect(f.count(OFFER)).toBe(2)
  })

  test('a later negotiation goes straight to the offer: the computer\'s direct-connection info is remembered', async () => {
    const f = setup()
    await f.upgrade()
    expect(f.cf).toEqual(['GET /api/sessions', INFO, OFFER])
    f.rtc.peers[0]!.emitState('failed')
    await f.retryAfterLoss()
    expect(f.link.path).toBe('lan')
    expect(f.cf).toEqual(['GET /api/sessions', INFO, OFFER, OFFER])
  })

  test('an offer refused because direct connections are now off waits a minute like "off", then asks for the info again', async () => {
    const f = setup()
    await f.upgrade()
    // Turned off on the computer (or its direct-connection host restarting): the gateway answers 503 P2P_UNAVAILABLE.
    f.server.offerStatus = 503
    f.server.offerCode = 'P2P_UNAVAILABLE'
    f.rtc.peers[0]!.emitState('failed')
    await f.retryAfterLoss()
    expect(f.count(OFFER)).toBe(2)
    expect(f.count(INFO)).toBe(1)
    expect(f.link.path).toBe('cf')
    // Not a failure to connect: coming back or a network change does not ask again before the minute is up.
    f.link.background()
    f.timers.advance(1000)
    f.link.foreground()
    f.link.networkChanged()
    f.timers.advance(0)
    await flush()
    expect(f.count(OFFER)).toBe(2)
    f.server.offerStatus = undefined
    f.server.offerCode = undefined
    f.timers.advance(UNAVAILABLE_RECHECK_MS)
    await flush()
    f.timers.advance(10)
    await flush()
    expect(f.cf.slice(-2)).toEqual([INFO, OFFER])
    expect(f.link.path).toBe('lan')
  })

  test('an offer the computer no longer supports (404) stops asking, and forgets the remembered info', async () => {
    const f = setup()
    await f.upgrade()
    f.server.offerStatus = 404
    f.rtc.peers[0]!.emitState('failed')
    await f.retryAfterLoss()
    expect(f.count(OFFER)).toBe(2)
    expect(f.count(INFO)).toBe(1)
    f.link.networkChanged()
    f.timers.advance(60 * 60_000)
    await flush()
    expect(f.count(OFFER)).toBe(2)
    f.server.offerStatus = undefined
    f.timers.advance(UNSUPPORTED_MS)
    await flush()
    f.timers.advance(10)
    await flush()
    expect(f.cf.slice(-2)).toEqual([INFO, OFFER])
  })

  test('a GET cut off on the direct path is retried on Cloudflare; a POST is never resent', async () => {
    const f = setup()
    await f.upgrade()
    const get = f.link.fetch('https://desk.example.test/api/sessions', init())
    const post = f.link.fetch('https://desk.example.test/api/sessions', init('POST'))
    await flush()
    f.rtc.peers[0]!.emitState('failed')
    expect(await (await get).text()).toBe('{"via":"cloudflare"}')
    await expect(post).rejects.toThrow('Direct connection closed')
    expect(f.cf.filter((entry) => entry === 'POST /api/sessions')).toHaveLength(0)
  })
})
