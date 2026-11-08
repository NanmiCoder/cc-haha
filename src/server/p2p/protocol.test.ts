import { describe, expect, test } from 'bun:test'
import { chunkText, decodeFrame, encodeFrame, P2P_CHUNK, P2P_FRAME_LIMIT } from './protocol.js'

describe('P2P frames', () => {
  test('round-trips a request header and a payload that itself contains newlines', () => {
    const text = encodeFrame({ t: 'req', s: 3, m: 'POST', p: '/api/sessions?x=1', h: { 'content-type': 'application/json' }, b: 'text', fin: true }, '{"a":1}\n{"b":2}')
    expect(decodeFrame(text)).toEqual({
      header: { t: 'req', s: 3, m: 'POST', p: '/api/sessions?x=1', h: { 'content-type': 'application/json' }, b: 'text', fin: true },
      payload: '{"a":1}\n{"b":2}',
    })
  })

  test.each([
    ['no separator', '{"t":"ping","n":1}'],
    ['bad json', '{nope\n'],
    ['unknown type', '{"t":"teleport","s":1}\n'],
    ['zero stream id', '{"t":"wsa","s":0}\n'],
    ['absolute-form path', '{"t":"wso","s":1,"p":"//evil.example/ws","h":{}}\n'],
    ['path with whitespace', '{"t":"wso","s":1,"p":"/ws/a b","h":{}}\n'],
    ['unsupported method', '{"t":"req","s":1,"m":"CONNECT","p":"/api","h":{},"b":"none","fin":true}\n'],
    ['header injection', '{"t":"req","s":1,"m":"GET","p":"/api","h":{"x\\r\\ny":"1"},"b":"none","fin":true}\n'],
    ['header value with a line break', '{"t":"req","s":1,"m":"GET","p":"/api","h":{"x":"a\\r\\nb: 1"},"b":"none","fin":true}\n'],
    ['header value with NUL', '{"t":"wso","s":1,"p":"/ws/s","h":{"x":"a\\u0000"}}\n'],
    ['header value outside Latin-1', '{"t":"req","s":1,"m":"GET","p":"/api","h":{"x-name":"截图.png"},"b":"none","fin":true}\n'],
    ['header value with a control character', '{"t":"req","s":1,"m":"GET","p":"/api","h":{"x":"a\\u007f"},"b":"none","fin":true}\n'],
    ['oversized frame', `{"t":"wsm","s":1,"fin":true}\n${'x'.repeat(P2P_FRAME_LIMIT)}`],
  ])('rejects %s', (_label, text) => {
    expect(decodeFrame(text)).toBeNull()
  })

  test('accepts every header value a Request can carry', () => {
    const h = { authorization: 'Bearer abc.def', 'x-tab': 'a\tb', 'x-latin': 'café ÿ', 'x-empty': '' }
    const frame = decodeFrame(encodeFrame({ t: 'req', s: 1, m: 'GET', p: '/api', h, b: 'none', fin: true }))
    expect(frame?.header).toMatchObject({ h })
    expect(() => new Request('https://example.test/api', { headers: h })).not.toThrow()
  })

  test('chunks never split a surrogate pair', () => {
    const emoji = '😀'
    const text = 'a'.repeat(P2P_CHUNK - 1) + emoji + 'b'
    const chunks = chunkText(text)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
      expect(chunk.length).toBeLessThanOrEqual(P2P_CHUNK)
    }
    expect(chunkText('')).toEqual([''])
  })
})
