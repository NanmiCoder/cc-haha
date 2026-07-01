import { describe, expect, it } from 'vitest'
import { LspFrameDecodeError, LspFrameDecoder, encodeLspFrame } from './lspJsonRpc'

function frameBytes(payload: unknown): Buffer {
  return encodeLspFrame(payload)
}

describe('encodeLspFrame', () => {
  it('emits a Content-Length header followed by the JSON body', () => {
    const out = encodeLspFrame({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    const text = out.toString('utf-8')
    expect(text.startsWith('Content-Length: ')).toBe(true)
    const headerEnd = text.indexOf('\r\n\r\n')
    expect(headerEnd).toBeGreaterThan(0)
    const body = text.slice(headerEnd + 4)
    expect(JSON.parse(body)).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  })

  it('uses the byte length of UTF-8 (not character length) in Content-Length', () => {
    const out = encodeLspFrame({ note: '你好🌏' })
    const text = out.toString('utf-8')
    const match = /^Content-Length: (\d+)\r\n\r\n/.exec(text)
    expect(match).not.toBeNull()
    const declared = Number.parseInt(match![1]!, 10)
    const body = text.slice(text.indexOf('\r\n\r\n') + 4)
    expect(Buffer.byteLength(body, 'utf-8')).toBe(declared)
    expect(declared).toBeGreaterThan(JSON.stringify({ note: '你好🌏' }).length - 5)
  })
})

describe('LspFrameDecoder', () => {
  it('decodes a single complete frame in one push', () => {
    const decoder = new LspFrameDecoder()
    const frames = decoder.push(frameBytes({ jsonrpc: '2.0', id: 1 }))
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0]!.bodyBytes.toString('utf-8'))).toEqual({ jsonrpc: '2.0', id: 1 })
  })

  it('handles two frames concatenated in a single push', () => {
    const decoder = new LspFrameDecoder()
    const buf = Buffer.concat([
      frameBytes({ jsonrpc: '2.0', id: 1 }),
      frameBytes({ jsonrpc: '2.0', id: 2 }),
    ])
    const frames = decoder.push(buf)
    expect(frames).toHaveLength(2)
    expect(JSON.parse(frames[0]!.bodyBytes.toString('utf-8')).id).toBe(1)
    expect(JSON.parse(frames[1]!.bodyBytes.toString('utf-8')).id).toBe(2)
  })

  it('handles a frame split across many small pushes', () => {
    const decoder = new LspFrameDecoder()
    const full = frameBytes({ jsonrpc: '2.0', id: 42, params: { x: 1 } })
    const collected: ReturnType<typeof decoder.push>[number][] = []
    for (let i = 0; i < full.length; i += 3) {
      collected.push(...decoder.push(full.subarray(i, Math.min(i + 3, full.length))))
    }
    expect(collected).toHaveLength(1)
    expect(JSON.parse(collected[0]!.bodyBytes.toString('utf-8'))).toEqual({
      jsonrpc: '2.0',
      id: 42,
      params: { x: 1 },
    })
  })

  it('handles a header split across two pushes followed by a complete body', () => {
    const decoder = new LspFrameDecoder()
    const full = frameBytes({ id: 7 })
    const split = Math.floor(full.length / 3)
    expect(decoder.push(full.subarray(0, split))).toHaveLength(0)
    const frames = decoder.push(full.subarray(split))
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0]!.bodyBytes.toString('utf-8')).id).toBe(7)
  })

  it('throws LspFrameDecodeError when the header has no Content-Length', () => {
    const decoder = new LspFrameDecoder()
    const bad = Buffer.from('Content-Type: application/json\r\n\r\n{}', 'ascii')
    expect(() => decoder.push(bad)).toThrow(LspFrameDecodeError)
  })

  it('throws LspFrameDecodeError on a non-numeric Content-Length', () => {
    const decoder = new LspFrameDecoder()
    const bad = Buffer.from('Content-Length: abc\r\n\r\n{}', 'ascii')
    expect(() => decoder.push(bad)).toThrow(LspFrameDecodeError)
  })

  it('reset() drops a half-buffered frame so a new frame parses cleanly', () => {
    const decoder = new LspFrameDecoder()
    decoder.push(Buffer.from('Content-Length: 100\r\n\r\n{partial', 'ascii'))
    decoder.reset()
    const frames = decoder.push(frameBytes({ id: 'after-reset' }))
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0]!.bodyBytes.toString('utf-8')).id).toBe('after-reset')
  })

  it('accepts UTF-8 bodies including multibyte characters', () => {
    const decoder = new LspFrameDecoder()
    const frames = decoder.push(frameBytes({ msg: 'naïve 你好 🌏' }))
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0]!.bodyBytes.toString('utf-8'))).toEqual({ msg: 'naïve 你好 🌏' })
  })
})
