import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PublicAccessServer } from '../publicAccess.js'
import { createResumableSocketHandler } from '../ws/resumableStreams.js'
import { P2PBroker } from './broker.js'
import { createP2PMux } from './mux.js'
import {
  decodeFrame,
  encodeFrame,
  P2P_CHUNK,
  P2P_REQUEST_BODY_LIMIT,
  P2P_SOCKET_MESSAGE_LIMIT,
  type P2PFrame,
  type P2PHeader,
} from './protocol.js'

const ORIGIN = 'https://fixture.trycloudflare.com'
const STREAM = 'PPPPPPPPPPPPPPPPPPPPPP'
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

/** A real gateway, stream layer and broker, with a fake Electron endpoint. */
async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2p-mux-test-'))
  const oldToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-process-credential'
  const api: { path: string; aborted?: boolean }[] = []
  const sessionFrames: string[] = []
  let session: { send(text: string): unknown } | undefined
  const sockets = createResumableSocketHandler({
    open(ws: { send(text: string): unknown }) { session = ws; ws.send('{"type":"connected"}') },
    message(_ws: unknown, text: string | Buffer) { sessionFrames.push(String(text)) },
    close() {},
  } as never, { epoch: 'p2p-epoch' })
  let broker: P2PBroker | undefined
  const service = new PublicAccessServer({
    storePath: path.join(dir, 'devices.json'), serverPort: () => 3456,
    handleApiRequest: async (request, url) => {
      const entry: { path: string; aborted?: boolean } = { path: url.pathname + url.search }
      api.push(entry)
      if (url.searchParams.has('slow')) {
        await new Promise(resolve => setTimeout(resolve, 200))
        entry.aborted = request.signal.aborted
      }
      if (url.pathname.endsWith('/tool-images/t/0')) return new Response(new Uint8Array([0, 1, 2, 255]), { headers: { 'content-type': 'image/png' } })
      return Response.json({ ok: true, path: url.pathname, body: request.method === 'GET' ? null : await request.text() })
    },
    handleStatic: async () => null,
    websocket: sockets as never,
    p2p: () => broker,
  })
  broker = new P2PBroker({ gateway: () => service.tunnel() })
  service.enable(ORIGIN)
  const base = `http://127.0.0.1:${service.status().port}`
  cleanups.push(() => {
    service.disable()
    broker!.closeAll()
    if (oldToken === undefined) delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
    else process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = oldToken
    rmSync(dir, { recursive: true, force: true })
  })
  const control = (route: string, body: unknown = {}) => service.control(new Request(`http://localhost/api/public-access/${route}`, {
    method: 'POST', headers: { Authorization: 'Bearer fixture-process-credential' }, body: JSON.stringify(body),
  }))
  const remote = (route: string, init: RequestInit = {}) => fetch(`${base}${route}`, {
    ...init, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  // Pair a native phone the way the app does.
  const code = await (await control('pairing')).json() as { secret: string }
  const pending = await (await remote('/api/public-access/pair', { method: 'POST', body: JSON.stringify({ secret: code.secret, clientType: 'native' }) })).json() as { id: string; claimSecret: string }
  await control('approve', { id: pending.id })
  const claim = await (await remote('/api/public-access/claim', { method: 'POST', body: JSON.stringify(pending) })).json() as { token: string; deviceId: string }
  const auth = { Authorization: `Bearer ${claim.token}` }

  const endpoint = {
    lines: [] as string[],
    send(text: string) { this.lines.push(text) },
    close() {},
  }
  broker.attachEndpoint(endpoint)
  // Signal through the gateway exactly as the phone does, answering as the endpoint.
  const offered = remote('/api/public-access/p2p/offer', { method: 'POST', headers: auth, body: JSON.stringify({ sdp: 'v=0 offer', candidates: [], complete: true }) })
  for (let i = 0; i < 50 && !endpoint.lines.some(line => line.startsWith('#')); i++) await Bun.sleep(5)
  const offer = JSON.parse(endpoint.lines.find(line => line.startsWith('#'))!.slice(1)) as { peerId: string }
  broker.receive(endpoint, '#' + JSON.stringify({ type: 'answer', peerId: offer.peerId, sdp: 'v=0 answer', candidates: [], complete: true }))
  const answer = await (await offered).json() as { peerId: string; sdp: string }
  expect(answer).toMatchObject({ peerId: offer.peerId, sdp: 'v=0 answer' })
  const peer = answer.peerId

  const frames = (channel?: string) => endpoint.lines
    .filter(line => line.startsWith(`${peer}|`) && (!channel || line.startsWith(`${peer}|${channel}|`)))
    .map(line => decodeFrame(line.slice(line.indexOf('|', peer.length + 1) + 1))!)
  const send = (channel: 'ctl' | 'bulk', header: P2PHeader, payload = '') => broker!.receive(endpoint, `${peer}|${channel}|${encodeFrame(header, payload)}`)
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5)
    expect(check()).toBe(true)
  }
  return { service, broker, base, auth, claim, remote, api, frames, send, until, sessionFrames, session: () => session!, sockets }
}

describe('requests over a P2P data channel', () => {
  test('reach the same gateway, with the same answers Cloudflare traffic gets', async () => {
    const f = await setup()
    const headers = { ...f.auth, Origin: ORIGIN }
    f.send('bulk', { t: 'req', s: 1, m: 'GET', p: '/api/sessions?limit=5', h: headers, b: 'none', fin: true })
    f.send('bulk', { t: 'req', s: 3, m: 'POST', p: '/api/sessions', h: { ...headers, 'content-type': 'application/json' }, b: 'text', fin: false }, '{"workDir":')
    f.send('bulk', { t: 'reqb', s: 3, fin: true }, '"/tmp"}')
    f.send('bulk', { t: 'req', s: 5, m: 'GET', p: '/api/h5-access/status', h: headers, b: 'none', fin: true })
    f.send('bulk', { t: 'req', s: 7, m: 'GET', p: '/api/sessions', h: { Origin: ORIGIN }, b: 'none', fin: true })
    f.send('bulk', { t: 'req', s: 9, m: 'POST', p: '/api/sessions', h: { ...f.auth, Origin: 'https://evil.example' }, b: 'none', fin: true })
    await f.until(() => f.frames('bulk').filter(frame => frame.header.t === 'res').length === 5)
    const status = Object.fromEntries(f.frames('bulk').filter(frame => frame.header.t === 'res').map(frame => [
      (frame.header as { s: number }).s, (frame.header as { st: number }).st,
    ]))
    expect(status).toEqual({ 1: 200, 3: 200, 5: 403, 7: 401, 9: 403 })
    const created = f.frames('bulk').find(frame => frame.header.t === 'res' && (frame.header as { s: number }).s === 3)!
    expect(JSON.parse(created.payload)).toEqual({ ok: true, path: '/api/sessions', body: '{"workDir":"/tmp"}' })
    expect(f.api.map(entry => entry.path)).toEqual(['/api/sessions?limit=5', '/api/sessions'])
  })

  test('binary bodies arrive intact as base64', async () => {
    const f = await setup()
    f.send('bulk', { t: 'req', s: 1, m: 'GET', p: '/api/sessions/s/tool-images/t/0', h: { ...f.auth, Origin: ORIGIN }, b: 'none', fin: true })
    await f.until(() => f.frames('bulk').some(frame => frame.header.t === 'res'))
    const response = f.frames('bulk').find(frame => frame.header.t === 'res')!
    expect(response.header).toMatchObject({ st: 200, b: 'b64', fin: true })
    expect([...Buffer.from(response.payload, 'base64')]).toEqual([0, 1, 2, 255])
  })

  test('a reset from the phone aborts the request on the computer', async () => {
    const f = await setup()
    f.send('bulk', { t: 'req', s: 1, m: 'GET', p: '/api/sessions?slow=1', h: { ...f.auth, Origin: ORIGIN }, b: 'none', fin: true })
    await f.until(() => f.api.length === 1)
    f.send('ctl', { t: 'rst', s: 1, code: 'aborted' })
    await f.until(() => f.api[0]!.aborted !== undefined)
    expect(f.api[0]!.aborted).toBe(true)
    await Bun.sleep(20)
    expect(f.frames('bulk').some(frame => frame.header.t === 'res')).toBe(false)
  })

  test('a peer cannot speak for a different paired device', async () => {
    const f = await setup()
    // Pair a second phone; its credential must not be usable over the first phone's peer.
    const code = await (await f.service.control(new Request('http://localhost/api/public-access/pairing', { method: 'POST', headers: { Authorization: 'Bearer fixture-process-credential' }, body: '{}' }))).json() as { secret: string }
    const pending = await (await f.remote('/api/public-access/pair', { method: 'POST', body: JSON.stringify({ secret: code.secret, clientType: 'native' }) })).json() as { id: string; claimSecret: string }
    await f.service.control(new Request('http://localhost/api/public-access/approve', { method: 'POST', headers: { Authorization: 'Bearer fixture-process-credential' }, body: JSON.stringify({ id: pending.id }) }))
    const other = await (await f.remote('/api/public-access/claim', { method: 'POST', body: JSON.stringify(pending) })).json() as { token: string }
    f.send('bulk', { t: 'req', s: 1, m: 'GET', p: '/api/sessions', h: { Authorization: `Bearer ${other.token}`, Origin: ORIGIN }, b: 'none', fin: true })
    await f.until(() => f.frames('bulk').some(frame => frame.header.t === 'res'))
    expect(f.frames('bulk')[0]!.header).toMatchObject({ st: 403 })
    expect(f.api).toEqual([])
  })

  test('a session socket over P2P moves to Cloudflare when the path drops, with nothing lost', async () => {
    const f = await setup()
    f.send('ctl', { t: 'wso', s: 2, p: `/ws/s1?media=ref&stream=${STREAM}`, h: { ...f.auth, Origin: ORIGIN } })
    await f.until(() => f.frames('ctl').some(frame => frame.header.t === 'wsa'))
    const received = () => f.frames('ctl').filter(frame => frame.header.t === 'wsm').map(frame => JSON.parse(frame.payload) as Record<string, unknown>)
    expect(received()[0]).toMatchObject({ type: 'stream_attached', resumed: false })
    expect(received()[1]).toEqual({ seq: 1, type: 'connected' })
    f.send('ctl', { t: 'wsm', s: 2, fin: true }, '{"cseq":1,"type":"sync_state"}')
    await f.until(() => f.sessionFrames.length === 1)
    expect(f.sessionFrames).toEqual(['{"type":"sync_state"}'])

    // The phone's direct path dies; output keeps coming.
    f.broker.closeAll()
    f.session().send('{"type":"content_delta","text":"after the drop"}')
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + `/ws/s1?media=ref&stream=${STREAM}&ack=1&epoch=p2p-epoch`, { headers: { ...f.auth, Origin: ORIGIN } })
    cleanups.push(() => ws.close())
    const replay: Record<string, unknown>[] = []
    ws.onmessage = event => replay.push(JSON.parse(String(event.data)))
    await f.until(() => replay.length >= 2)
    expect(replay[0]).toMatchObject({ type: 'stream_attached', resumed: true, cack: 1, next: 2 })
    expect(replay[1]).toEqual({ seq: 2, type: 'content_delta', text: 'after the drop' })
  })

  test('signaling needs the device and the public origin, and the endpoint link is never public', async () => {
    const f = await setup()
    expect((await f.remote('/api/public-access/p2p')).status).toBe(401)
    expect((await fetch(`${f.base}/api/public-access/p2p`, { headers: f.auth })).status).toBe(403)
    const ok = await f.remote('/api/public-access/p2p', { headers: f.auth })
    expect(await ok.json()).toMatchObject({ v: 1, available: true, gatherMs: 300 })
    expect((await f.remote('/api/public-access/p2p/endpoint', { headers: f.auth })).status).toBe(404)
  })

  test('a resume the computer cannot honor is refused over P2P as well', async () => {
    const f = await setup()
    f.send('ctl', { t: 'wso', s: 2, p: `/ws/s1?media=ref&stream=${STREAM}&ack=4&epoch=p2p-epoch`, h: { ...f.auth, Origin: ORIGIN } })
    await f.until(() => f.frames('ctl').some(frame => frame.header.t === 'wsc'))
    const frames = f.frames('ctl')
    expect(frames.filter(frame => frame.header.t === 'wsm').map(frame => JSON.parse(frame.payload))).toEqual([
      { type: 'stream_attached', v: 1, stream: STREAM, epoch: 'p2p-epoch', resumed: false, reason: 'expired', cack: 0, next: 1, last: 0 },
    ])
    expect(frames.find(frame => frame.header.t === 'wsc')!.header).toMatchObject({ code: 4001, reason: 'Stream not resumable' })
    expect(f.sockets.streamCount).toBe(0)
  })
})

/** One multiplexer over a scripted gateway: what the phone would see, frame by frame. */
function directMux(options: {
  fetch?: (request: Request, server: { upgrade(request: Request, options: { data: unknown }): boolean }) => Promise<Response | undefined>
  publicUrl?: string
  limits?: Parameters<typeof createP2PMux>[0]['limits']
  onSend?: (channel: 'ctl' | 'bulk', frame: P2PFrame) => void
} = {}) {
  const sent: { channel: 'ctl' | 'bulk'; frame: P2PFrame }[] = []
  const requests: Request[] = []
  const messages: string[] = []
  const mux = createP2PMux({
    deviceId: 'dev',
    limits: options.limits,
    send: (channel, text) => {
      const frame = decodeFrame(text)!
      sent.push({ channel, frame })
      options.onSend?.(channel, frame)
    },
    gateway: {
      fetch: async (request, server) => {
        requests.push(request)
        if (new URL(request.url).pathname.startsWith('/ws/')) return server.upgrade(request, { data: {} }) ? undefined : new Response(null, { status: 400 })
        return options.fetch ? options.fetch(request, server) : Response.json({ ok: true, body: request.method === 'GET' ? null : await request.text() })
      },
      socketHandlers: { open() {}, message(_ws, message) { messages.push(message) }, close() {} },
      deviceIdFor: () => 'dev',
      publicUrl: () => options.publicUrl ?? ORIGIN,
    },
  })
  const of = (stream: number) => sent.filter(item => 's' in item.frame.header && item.frame.header.s === stream).map(item => item.frame)
  const send = (channel: 'ctl' | 'bulk', header: P2PHeader, payload = '') => mux.receive(channel, encodeFrame(header, payload))
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
    expect(check()).toBe(true)
  }
  return { mux, sent, of, send, until, requests, messages }
}
const finished = (frames: P2PFrame[]) => frames.some(frame => (frame.header.t === 'res' || frame.header.t === 'resb') && frame.header.fin)

describe('P2P response flow control', () => {
  const body = 'x'.repeat(2 * 1024 * 1024)
  const big = async () => new Response(body, { headers: { 'content-type': 'text/plain' } })

  test('a pause from the endpoint stops a response mid-body; resuming sends the rest in order', async () => {
    let schedulePause = true
    const m = directMux({
      fetch: big,
      // The endpoint's pause arrives asynchronously, as it does over the loopback link.
      onSend: () => { if (schedulePause) { schedulePause = false; setTimeout(() => m.mux.setPaused('bulk', true), 0) } },
    })
    m.send('bulk', { t: 'req', s: 1, m: 'GET', p: '/api/sessions/s/messages', h: {}, b: 'none', fin: true })
    await m.until(() => m.of(1).length > 0)
    await Bun.sleep(30)
    const atPause = m.of(1).length
    const total = Math.ceil(body.length / P2P_CHUNK)
    expect(atPause).toBeLessThan(total)
    await Bun.sleep(50)
    expect(m.of(1)).toHaveLength(atPause)
    // Resuming does not dump the rest of the body into the endpoint in one go.
    m.mux.setPaused('bulk', false)
    expect(m.of(1).length - atPause).toBeLessThanOrEqual(4)
    await m.until(() => finished(m.of(1)))
    const frames = m.of(1)
    expect(frames).toHaveLength(total)
    expect(frames[0]!.header).toMatchObject({ t: 'res', st: 200, b: 'text', fin: false })
    expect(frames.slice(1).every(frame => frame.header.t === 'resb')).toBe(true)
    expect(frames.map(frame => frame.payload).join('')).toBe(body)
  })

  test('a reset stops the response and drops its frames still waiting to be sent', async () => {
    const m = directMux({ fetch: big, onSend: (_channel, frame) => { if (frame.header.t === 'res' && frame.header.s === 1) m.mux.setPaused('bulk', true) } })
    m.send('bulk', { t: 'req', s: 1, m: 'GET', p: '/api/sessions/s/messages', h: {}, b: 'none', fin: true })
    await m.until(() => m.of(1).length > 0)
    await Bun.sleep(20)
    m.send('ctl', { t: 'rst', s: 1, code: 'aborted' })
    m.mux.setPaused('bulk', false)
    expect(m.of(1)).toHaveLength(1)
    await Bun.sleep(50)
    expect(m.of(1)).toHaveLength(1)
    expect(finished(m.of(1))).toBe(false)
    // Other streams on the same peer carry on.
    m.send('bulk', { t: 'req', s: 3, m: 'GET', p: '/api/sessions', h: {}, b: 'none', fin: true })
    await m.until(() => finished(m.of(3)))
  })

  test('closing the peer ends a response that is waiting for room', async () => {
    const m = directMux({ fetch: big, onSend: (_channel, frame) => { if (frame.header.t === 'res') m.mux.setPaused('bulk', true) } })
    m.send('bulk', { t: 'req', s: 1, m: 'GET', p: '/api/sessions/s/messages', h: {}, b: 'none', fin: true })
    await m.until(() => m.of(1).length > 0)
    m.mux.close()
    m.mux.setPaused('bulk', false)
    await Bun.sleep(30)
    expect(m.of(1)).toHaveLength(1)
  })

  test('a streamed body keeps characters and bytes whole across frames', async () => {
    const encoder = new TextEncoder()
    const text = 'a'.repeat(P2P_CHUNK - 1) + '😀' + '中'.repeat(P2P_CHUNK) + 'end'
    const textBytes = encoder.encode(text)
    const binary = new Uint8Array(40_001).map((_, index) => (index * 7) % 256)
    // Deliver both bodies in awkward pieces: a split inside a UTF-8 sequence and odd byte counts.
    const pieces = (bytes: Uint8Array, size: number) => new ReadableStream<Uint8Array>({
      start(controller) {
        for (let start = 0; start < bytes.length; start += size) controller.enqueue(bytes.slice(start, start + size))
        controller.close()
      },
    })
    const m = directMux({
      fetch: async request => new URL(request.url).pathname.endsWith('/text')
        ? new Response(pieces(textBytes, 4097), { headers: { 'content-type': 'application/json' } })
        : new Response(pieces(binary, 5001), { headers: { 'content-type': 'image/png' } }),
    })
    m.send('bulk', { t: 'req', s: 1, m: 'GET', p: '/api/text', h: {}, b: 'none', fin: true })
    m.send('bulk', { t: 'req', s: 3, m: 'GET', p: '/api/image', h: {}, b: 'none', fin: true })
    await m.until(() => finished(m.of(1)) && finished(m.of(3)))
    const textFrames = m.of(1)
    expect(textFrames[0]!.header).toMatchObject({ b: 'text' })
    for (const frame of textFrames) {
      const last = frame.payload.charCodeAt(frame.payload.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
      expect(frame.payload.length).toBeLessThanOrEqual(P2P_CHUNK)
    }
    expect(textFrames.map(frame => frame.payload).join('')).toBe(text)
    const binaryFrames = m.of(3)
    expect(binaryFrames[0]!.header).toMatchObject({ b: 'b64' })
    for (const frame of binaryFrames.slice(0, -1)) expect(frame.payload.length % 4 === 0 && !frame.payload.endsWith('=')).toBe(true)
    expect([...Buffer.from(binaryFrames.map(frame => frame.payload).join(''), 'base64')]).toEqual([...binary])
  })

  test('an empty body is still a single response frame', async () => {
    const m = directMux({ fetch: async () => new Response(null, { status: 204 }) })
    m.send('bulk', { t: 'req', s: 1, m: 'DELETE', p: '/api/sessions/s', h: {}, b: 'none', fin: true })
    await m.until(() => finished(m.of(1)))
    expect(m.of(1).map(frame => frame.header)).toEqual([{ t: 'res', s: 1, st: 204, h: {}, b: 'none', fin: true }])
  })
})

describe('P2P request admission', () => {
  test('a header value a Request cannot carry is answered with 400, never left hanging', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      const m = directMux()
      m.send('bulk', { t: 'req', s: 1, m: 'GET', p: '/api/sessions', h: { 'X-Name': '截图.png' }, b: 'none', fin: true })
      m.send('ctl', { t: 'wso', s: 3, p: '/ws/s1', h: { 'X-Name': 'a\nb' } })
      // Not a protocol violation, but still no valid Request (the gateway URL is broken).
      const broken = directMux({ publicUrl: 'not a url' })
      broken.send('bulk', { t: 'req', s: 5, m: 'GET', p: '/api/sessions', h: {}, b: 'none', fin: true })
      broken.send('ctl', { t: 'wso', s: 7, p: '/ws/s1', h: {} })
      await m.until(() => m.of(1).length > 0 && m.of(3).length > 0 && broken.of(5).length > 0 && broken.of(7).length > 0)
      await Bun.sleep(10)
      expect(m.of(1).map(frame => frame.header)).toEqual([expect.objectContaining({ t: 'res', st: 400, fin: true })])
      expect(m.sent.find(item => item.frame.header.t === 'res' && item.frame.header.s === 3)!.channel).toBe('ctl')
      expect(m.of(3).map(frame => frame.header)).toEqual([expect.objectContaining({ t: 'res', st: 400, fin: true })])
      expect(broken.of(5).map(frame => frame.header)).toEqual([expect.objectContaining({ t: 'res', st: 400 })])
      expect(broken.of(7).map(frame => frame.header)).toEqual([expect.objectContaining({ t: 'res', st: 400 })])
      expect(m.requests).toEqual([])
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  test('bodies still arriving are limited in number, in total bytes and in time', async () => {
    const m = directMux({ limits: { pendingRequests: 2, pendingBytes: 4000, assemblyMs: 40 } })
    const start = (s: number, payload = '') => m.send('bulk', { t: 'req', s, m: 'POST', p: '/api/x', h: {}, b: 'text', fin: false }, payload)
    start(1, '中'.repeat(1000))
    start(3)
    start(5)
    expect(m.of(5).map(frame => frame.header)).toEqual([expect.objectContaining({ t: 'res', st: 429 })])
    // 3000 bytes already wait on stream 1; 1200 more on stream 3 goes over the total.
    m.send('bulk', { t: 'reqb', s: 3, fin: false }, '中'.repeat(400))
    expect(m.of(3).map(frame => frame.header)).toEqual([expect.objectContaining({ t: 'res', st: 429 })])
    await m.until(() => m.of(1).length > 0)
    expect(m.of(1).map(frame => frame.header)).toEqual([expect.objectContaining({ t: 'res', st: 408 })])
    // A late remainder never runs the expired request.
    m.send('bulk', { t: 'reqb', s: 1, fin: true }, 'tail')
    await Bun.sleep(20)
    expect(m.requests).toEqual([])
    // With room again, a body that completes in time runs.
    start(9, 'he')
    m.send('bulk', { t: 'reqb', s: 9, fin: true }, 'llo')
    await m.until(() => finished(m.of(9)))
    expect(JSON.parse(m.of(9)[0]!.payload)).toEqual({ ok: true, body: 'hello' })
  })

  test('the request body and socket message limits count bytes, as the gateway does', async () => {
    const m = directMux()
    // Three bytes per character: under the limit in characters, over it in bytes.
    const piece = '中'.repeat(P2P_CHUNK)
    const frames = Math.ceil(P2P_REQUEST_BODY_LIMIT / Buffer.byteLength(piece)) + 1
    m.send('bulk', { t: 'req', s: 1, m: 'POST', p: '/api/x', h: {}, b: 'text', fin: false }, piece)
    for (let index = 1; index < frames && !m.of(1).length; index++) m.send('bulk', { t: 'reqb', s: 1, fin: index === frames - 1 }, piece)
    expect(m.of(1).map(frame => frame.header)).toEqual([expect.objectContaining({ t: 'res', st: 413 })])
    expect(m.requests).toEqual([])

    m.send('ctl', { t: 'wso', s: 3, p: '/ws/s1', h: {} })
    await m.until(() => m.of(3).some(frame => frame.header.t === 'wsa'))
    const parts = Math.ceil(P2P_SOCKET_MESSAGE_LIMIT / Buffer.byteLength(piece)) + 1
    for (let index = 0; index < parts && !m.of(3).some(frame => frame.header.t === 'wsc'); index++) m.send('ctl', { t: 'wsm', s: 3, fin: index === parts - 1 }, piece)
    expect(m.of(3).find(frame => frame.header.t === 'wsc')!.header).toMatchObject({ code: 1009 })
    expect(m.messages).toEqual([])
  })
})
