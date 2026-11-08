import { describe, expect, test } from 'bun:test'
import { base64ToBytes, bytesToBase64 } from '../base64'
import { ApiClient } from '../client'
import { decodeFrame, encodeFrame, type P2PChannel } from './frames'
import { Tunnel } from './tunnel'

// The computer's half, imported the way the other protocol tests do: both sides must agree.
type Mux = { receive(channel: P2PChannel, text: string): void; close(): void }
const server = await import(new URL('../../../../src/server/p2p/mux.ts', import.meta.url).href) as {
  createP2PMux(options: {
    deviceId: string
    gateway: unknown
    send(channel: P2PChannel, text: string): void
  }): Mux
}

const init = (overrides: Partial<Parameters<Tunnel['fetch']>[1]> = {}) => ({
  method: 'GET', headers: { Authorization: 'Bearer native_fixture' }, signal: new AbortController().signal,
  redirect: 'error' as const, credentials: 'omit' as const, ...overrides,
})

describe('tunnel over a data channel', () => {
  test('a request goes out as frames and its response comes back whole', async () => {
    const sent: { channel: P2PChannel; text: string }[] = []
    const tunnel = new Tunnel({ send: (channel, text) => { sent.push({ channel, text }); return true } })
    const response = tunnel.fetch('https://desk.example.test/api/sessions?limit=5', init())
    expect(sent).toHaveLength(1)
    expect(sent[0]!.channel).toBe('bulk')
    expect(decodeFrame(sent[0]!.text)!.header).toEqual({ t: 'req', s: 1, m: 'GET', p: '/api/sessions?limit=5', h: { Authorization: 'Bearer native_fixture' }, b: 'none', fin: true })
    tunnel.receive(encodeFrame({ t: 'res', s: 1, st: 200, h: { 'Content-Type': 'application/json' }, b: 'text', fin: false }, '{"a":'))
    tunnel.receive(encodeFrame({ t: 'resb', s: 1, fin: true }, '1}'))
    const result = await response
    expect(result.status).toBe(200)
    expect(result.headers!.get('content-type')).toBe('application/json')
    expect(await result.text()).toBe('{"a":1}')
  })

  test('aborting sends a reset and rejects; a lost channel rejects what is still waiting', async () => {
    const sent: string[] = []
    const tunnel = new Tunnel({ send: (_channel, text) => { sent.push(text); return true } })
    const controller = new AbortController()
    const aborted = tunnel.fetch('https://desk.example.test/api/slow', init({ signal: controller.signal }))
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(decodeFrame(sent.at(-1))!.header).toEqual({ t: 'rst', s: 1, code: 'aborted' })
    const waiting = tunnel.fetch('https://desk.example.test/api/other', init())
    tunnel.close()
    await expect(waiting).rejects.toThrow('Direct connection closed')
    await expect(tunnel.fetch('https://desk.example.test/api/later', init())).rejects.toThrow('Direct connection closed')
  })

  /** 答复头到了就要交给调用方；没交出来时快速失败，而不是让测试挂到超时。 */
  const headed = <T,>(response: Promise<T>) =>
    Promise.race([
      response,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('response not handed over at its headers')), 200)),
    ])

  test('the "is the computer there" deadline ends at the headers; a slow body only needs the body budget', async () => {
    let tunnel!: Tunnel
    tunnel = new Tunnel({
      send: (_channel, text) => {
        const frame = decodeFrame(text)
        if (frame?.header.t === 'req') {
          const s = frame.header.s
          // The computer answers at once (headers and a first chunk); the rest trickles in.
          setTimeout(() => tunnel.receive(encodeFrame({ t: 'res', s, st: 200, h: { 'content-type': 'application/json' }, b: 'text', fin: false }, '{"a":')), 5)
          setTimeout(() => tunnel.receive(encodeFrame({ t: 'resb', s, fin: true }, '1}')), 150)
        }
        return true
      },
    })
    const host = { id: 'h', name: 'h', url: 'https://example.trycloudflare.com', auth: 'remote' as const }
    const api = new ApiClient(host, 'fake-token', { fetch: tunnel.fetch, timeoutMs: 100, bodyTimeoutMs: 1000 })
    expect(await api.get('/api/status')).toEqual({ a: 1 })
  })

  test('a channel lost or reset while the body is arriving fails the body, not the answered request', async () => {
    const tunnel = new Tunnel({ send: () => true })
    const first = tunnel.fetch('https://desk.example.test/api/sessions', init())
    tunnel.receive(encodeFrame({ t: 'res', s: 1, st: 200, h: {}, b: 'text', fin: false }, 'partial'))
    const response = await headed(first)
    expect(response.status).toBe(200)
    const reset = tunnel.fetch('https://desk.example.test/api/other', init())
    tunnel.receive(encodeFrame({ t: 'res', s: 2, st: 200, h: {}, b: 'text', fin: false }, 'partial'))
    const resetResponse = await headed(reset)
    const resetBody = resetResponse.text()
    tunnel.receive(encodeFrame({ t: 'rst', s: 2, code: 'aborted' }))
    await expect(resetBody).rejects.toThrow('Direct connection reset')
    const body = response.text()
    tunnel.close()
    await expect(body).rejects.toThrow('Direct connection closed')
  })

  test('aborting while the body is arriving sends a reset and fails the body', async () => {
    const sent: string[] = []
    const tunnel = new Tunnel({ send: (_channel, text) => { sent.push(text); return true } })
    const controller = new AbortController()
    const pending = tunnel.fetch('https://desk.example.test/api/big', init({ signal: controller.signal }))
    tunnel.receive(encodeFrame({ t: 'res', s: 1, st: 200, h: {}, b: 'b64', fin: false }, 'AAEC'))
    const response = await headed(pending)
    const body = response.arrayBuffer!()
    controller.abort()
    await expect(body).rejects.toMatchObject({ name: 'AbortError' })
    expect(decodeFrame(sent.at(-1))!.header).toEqual({ t: 'rst', s: 1, code: 'aborted' })
  })

  test('a session socket opens, carries messages both ways and closes like a network drop', async () => {
    const sent: string[] = []
    const tunnel = new Tunnel({ send: (_channel, text) => { sent.push(text); return true } })
    const socket = tunnel.socket('wss://desk.example.test/ws/s1?media=ref&stream=abc', { Origin: 'https://desk.example.test' })
    const events: string[] = []
    socket.onopen = () => events.push('open')
    socket.onmessage = ({ data }) => events.push(`message:${data}`)
    socket.onclose = ({ code }) => events.push(`close:${code}`)
    expect(decodeFrame(sent[0])!.header).toEqual({ t: 'wso', s: 1, p: '/ws/s1?media=ref&stream=abc', h: { Origin: 'https://desk.example.test' } })
    tunnel.receive(encodeFrame({ t: 'wsa', s: 1 }))
    expect(socket.readyState).toBe(1)
    socket.send('{"type":"sync_state"}')
    expect(decodeFrame(sent.at(-1))).toEqual({ header: { t: 'wsm', s: 1, fin: true }, payload: '{"type":"sync_state"}' })
    tunnel.receive(encodeFrame({ t: 'wsm', s: 1, fin: false }, '{"type":'))
    tunnel.receive(encodeFrame({ t: 'wsm', s: 1, fin: true }, '"pong"}'))
    tunnel.close()
    expect(events).toEqual(['open', 'message:{"type":"pong"}', 'close:1006'])
  })

  test('a rejected socket reports an authorization failure the way a refused handshake does', () => {
    const tunnel = new Tunnel({ send: () => true })
    const socket = tunnel.socket('wss://desk.example.test/ws/s1', {})
    let code = 0
    socket.onclose = (event) => { code = event.code }
    tunnel.receive(encodeFrame({ t: 'res', s: 1, st: 401, h: {}, b: 'none', fin: true }))
    expect(code).toBe(1008)
  })

  test('base64 round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes])
    expect(bytesToBase64(new Uint8Array([1, 2]))).toBe(Buffer.from([1, 2]).toString('base64'))
  })
})

describe('phone tunnel and computer multiplexer agree', () => {
  function pair(handle: (request: Request) => Promise<Response>) {
    let tunnel!: Tunnel
    const mux = server.createP2PMux({
      deviceId: 'phone',
      send: (_channel, text) => queueMicrotask(() => tunnel.receive(text)),
      gateway: {
        fetch: (request: Request) => handle(request),
        socketHandlers: { open() {}, message() {}, close() {} },
        deviceIdFor: () => 'phone',
        publicUrl: () => 'https://desk.example.test',
      },
    })
    tunnel = new Tunnel({ send: (channel, text) => { queueMicrotask(() => mux.receive(channel, text)); return true } })
    return tunnel
  }

  test('a large JSON body and response survive chunking in both directions', async () => {
    const big = JSON.stringify({ text: '汉字😀'.repeat(20_000) })
    const tunnel = pair(async (request) => new Response(await request.text(), { headers: { 'content-type': 'application/json' } }))
    const response = await tunnel.fetch('https://desk.example.test/api/sessions', init({ method: 'POST', body: big }))
    expect(await response.text()).toBe(big)
  })

  test('binary uploads and image downloads arrive byte for byte', async () => {
    const image = Uint8Array.from({ length: 50_000 }, (_, i) => (i * 7) & 255)
    const tunnel = pair(async (request) => {
      const received = new Uint8Array(await request.arrayBuffer())
      return new Response(received, { headers: { 'content-type': 'image/png' } })
    })
    const response = await tunnel.fetch('https://desk.example.test/api/upload', init({ method: 'POST', body: image.buffer }))
    expect(new Uint8Array(await response.arrayBuffer!())).toEqual(image)
  })
})
