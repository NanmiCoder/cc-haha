import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { shouldGzipResponse, withGzipIfEligible, sessionIdFromPath, MIN_COMPRESSIBLE_SESSION_BYTES } from './responseCompression.js'

const big = 'x'.repeat(300 * 1024)
const small = 'x'.repeat(1024)

function jsonReq(acceptEncoding?: string | null) {
  return new Request('http://127.0.0.1:7788/api/sessions/x/messages', {
    method: 'GET',
    headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
  })
}

function jsonRes(body: string) {
  return Response.json(JSON.parse(body))
}

describe('shouldGzipResponse', () => {
  test('compresses remote large json with gzip advertised', () => {
    expect(
      shouldGzipResponse(jsonReq('gzip, deflate'), jsonRes(`{"m":"${big}"}`), '192.168.1.50'),
    ).toBe(true)
  })

  test('skips loopback by default', () => {
    expect(
      shouldGzipResponse(jsonReq('gzip'), jsonRes(`{"m":"${big}"}`), '127.0.0.1'),
    ).toBe(false)
    expect(
      shouldGzipResponse(jsonReq('gzip'), jsonRes(`{"m":"${big}"}`), '::1'),
    ).toBe(false)
  })

  test('skips when client does not advertise gzip', () => {
    expect(
      shouldGzipResponse(jsonReq('br'), jsonRes(`{"m":"${big}"}`), '192.168.1.50'),
    ).toBe(false)
    expect(
      shouldGzipResponse(jsonReq(null), jsonRes(`{"m":"${big}"}`), '192.168.1.50'),
    ).toBe(false)
  })

  test('skips small payloads with a declared length', () => {
    const res = new Response(`{"m":"${small}"}`, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(`{"m":"${small}"}`)),
      },
    })
    expect(shouldGzipResponse(jsonReq('gzip'), res, '192.168.1.50')).toBe(false)
  })

  test('skips non-200 and non-GET', () => {
    const res = new Response(JSON.stringify({ error: 'x'.repeat(300 * 1024) }), {
      status: 413,
      headers: { 'content-type': 'application/json' },
    })
    expect(shouldGzipResponse(jsonReq('gzip'), res, '192.168.1.50')).toBe(false)

    const post = new Request('http://127.0.0.1:7788/api/x', {
      method: 'POST',
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(shouldGzipResponse(post, jsonRes(`{"m":"${big}"}`), '192.168.1.50')).toBe(false)
  })

  test('skips non-json content type', () => {
    const res = new Response(big, { headers: { 'content-type': 'text/html' } })
    expect(shouldGzipResponse(jsonReq('gzip'), res, '192.168.1.50')).toBe(false)
  })

  test('env CC_HAHA_TRANSPORT_GZIP=0 disables, =1 forces loopback', () => {
    const orig0 = process.env.CC_HAHA_TRANSPORT_GZIP
    process.env.CC_HAHA_TRANSPORT_GZIP = '0'
    expect(
      shouldGzipResponse(jsonReq('gzip'), jsonRes(`{"m":"${big}"}`), '192.168.1.50'),
    ).toBe(false)
    process.env.CC_HAHA_TRANSPORT_GZIP = '1'
    expect(
      shouldGzipResponse(jsonReq('gzip'), jsonRes(`{"m":"${big}"}`), '127.0.0.1'),
    ).toBe(true)
    if (orig0 === undefined) delete process.env.CC_HAHA_TRANSPORT_GZIP
    else process.env.CC_HAHA_TRANSPORT_GZIP = orig0
  })
})

describe('withGzipIfEligible', () => {
  let envBackup: string | undefined

  beforeEach(() => {
    envBackup = process.env.CC_HAHA_TRANSPORT_GZIP
    delete process.env.CC_HAHA_TRANSPORT_GZIP
  })

  afterEach(() => {
    if (envBackup === undefined) delete process.env.CC_HAHA_TRANSPORT_GZIP
    else process.env.CC_HAHA_TRANSPORT_GZIP = envBackup
  })

  test('compresses the body and sets content-encoding, client text is identical', async () => {
    const body = { messages: Array.from({ length: 300 }, (_, i) => ({ id: i, text: big.slice(0, 1000) })) }

    const out = await withGzipIfEligible(jsonReq('gzip'), jsonRes(JSON.stringify(body)), '192.168.1.50')

    expect(out.headers.get('content-encoding')).toBe('gzip')
    expect(Number(out.headers.get('content-length'))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(body)),
    )
    // 浏览器 fetch 按规范透明解压 gzip（res.text()/res.json() 拿到明文
    // JSON）；Bun 的 Response 不替我们解压，这里手动 gunzip 模拟客户端视角。
    const raw = new Uint8Array(await out.arrayBuffer())
    expect(JSON.parse(gunzipSync(raw).toString())).toEqual(body)
  })

  test('leaves loopback responses untouched', async () => {
    const body = { messages: [{ id: 1, text: big }] }
    const out = await withGzipIfEligible(jsonReq('gzip'), jsonRes(JSON.stringify(body)), '127.0.0.1')
    expect(out.headers.get('content-encoding')).toBeNull()
    expect(JSON.parse(await out.text())).toEqual(body)
  })

  test('leaves small responses untouched', async () => {
    const body = { ok: true, text: small }
    const out = await withGzipIfEligible(jsonReq('gzip'), jsonRes(JSON.stringify(body)), '192.168.1.50')
    expect(out.headers.get('content-encoding')).toBeNull()
  })

  describe('session size floor', () => {
    const bigBody = JSON.stringify({
      messages: Array.from({ length: 300 }, (_, i) => ({ id: i, text: big.slice(0, 1000) })),
    })
    const seen: Array<string> = []
    const resolver = (size: number | null) => async (sessionId: string) => {
      seen.push(sessionId)
      return size
    }

    test('compresses a session at or above the floor', async () => {
      seen.length = 0
      const out = await withGzipIfEligible(
        jsonReq('gzip'), jsonRes(bigBody), '192.168.1.50',
        resolver(MIN_COMPRESSIBLE_SESSION_BYTES),
      )
      expect(out.headers.get('content-encoding')).toBe('gzip')
      expect(seen).toEqual(['x'])
    })

    test('skips a session below the floor even when the response is large', async () => {
      const out = await withGzipIfEligible(
        jsonReq('gzip'), jsonRes(bigBody), '192.168.1.50',
        resolver(MIN_COMPRESSIBLE_SESSION_BYTES - 1),
      )
      expect(out.headers.get('content-encoding')).toBeNull()
      expect(JSON.parse(await out.text())).toEqual(JSON.parse(bigBody))
    })

    test('unknown size falls back to compressing', async () => {
      const out = await withGzipIfEligible(
        jsonReq('gzip'), jsonRes(bigBody), '192.168.1.50', resolver(null),
      )
      expect(out.headers.get('content-encoding')).toBe('gzip')
    })

    test('never resolves the size for loopback or non-session traffic', async () => {
      seen.length = 0
      // Loopback is rejected before the floor check.
      await withGzipIfEligible(jsonReq('gzip'), jsonRes(bigBody), '127.0.0.1', resolver(1))
      // Not session-scoped: no id to look up, and the response still compresses.
      const other = new Request('http://127.0.0.1:7788/api/settings', {
        method: 'GET', headers: { 'accept-encoding': 'gzip' },
      })
      const out = await withGzipIfEligible(other, jsonRes(bigBody), '192.168.1.50', resolver(1))
      expect(out.headers.get('content-encoding')).toBe('gzip')
      expect(seen).toEqual([])
    })

    test('a small response still compresses nothing, though the size is consulted', async () => {
      // `Response.json` sets no content-length, so `shouldGzipResponse` cannot
      // apply the per-response floor up front — it returns true and the real
      // size check happens after the body is buffered. The session lookup
      // therefore does run here; this pins that (slightly wasteful) ordering so
      // a future change to it is a deliberate one.
      seen.length = 0
      const out = await withGzipIfEligible(
        jsonReq('gzip'), jsonRes(`{"m":"${small}"}`), '192.168.1.50', resolver(1),
      )
      expect(out.headers.get('content-encoding')).toBeNull()
      expect(seen).toEqual(['x'])
    })
  })
})

describe('sessionIdFromPath', () => {
  test('extracts the session id and ignores other routes', () => {
    expect(sessionIdFromPath('/api/sessions/abc-123/messages')).toBe('abc-123')
    expect(sessionIdFromPath('/api/sessions/abc-123')).toBe('abc-123')
    expect(sessionIdFromPath('/api/sessions')).toBeNull()
    expect(sessionIdFromPath('/api/settings')).toBeNull()
    // Must not be fooled by a route that merely shares the prefix.
    expect(sessionIdFromPath('/api/sessionsfoo/bar')).toBeNull()
  })
})

