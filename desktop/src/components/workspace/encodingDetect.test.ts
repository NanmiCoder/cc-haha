import { describe, expect, it } from 'vitest'
import { detectEncoding, detectLineEnding } from './encodingDetect'

const utf8Encoder = new TextEncoder()

function bom(...rest: number[]): Uint8Array {
  return new Uint8Array([0xef, 0xbb, 0xbf, ...rest])
}

describe('detectEncoding', () => {
  it('flags pure UTF-8 ASCII content', () => {
    expect(detectEncoding(utf8Encoder.encode('hello world'))).toBe('utf-8')
  })

  it('flags multibyte UTF-8 (CJK + emoji) as utf-8', () => {
    expect(detectEncoding(utf8Encoder.encode('你好 🌏 — naïve'))).toBe('utf-8')
  })

  it('flags UTF-8 BOM prefix', () => {
    expect(detectEncoding(bom(0x68, 0x69 /* 'hi' */))).toBe('utf-8-bom')
  })

  it('flags an empty buffer as utf-8 (no BOM, vacuously valid)', () => {
    expect(detectEncoding(new Uint8Array())).toBe('utf-8')
  })

  it('flags UTF-16 LE BOM as unsupported', () => {
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x68, 0x00]))).toBe('unsupported')
  })

  it('flags UTF-16 BE BOM as unsupported', () => {
    expect(detectEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x68]))).toBe('unsupported')
  })

  it('flags invalid UTF-8 byte sequences as unsupported', () => {
    // 0xC0 / 0xC1 are never valid UTF-8 lead bytes (overlong encoding).
    expect(detectEncoding(new Uint8Array([0xc0, 0x80]))).toBe('unsupported')
  })

  it('flags a stray continuation byte (0x80 with no lead) as unsupported', () => {
    expect(detectEncoding(new Uint8Array([0x80, 0x61]))).toBe('unsupported')
  })

  it('flags Latin-1-only buffers (e.g. Windows-1252 0xE9 stand-alone) as unsupported', () => {
    // Lone 0xE9 (é in Latin-1) is an invalid UTF-8 lead byte without continuations.
    expect(detectEncoding(new Uint8Array([0x68, 0xe9, 0x6c, 0x6c, 0x6f]))).toBe('unsupported')
  })
})

describe('detectLineEnding', () => {
  it('returns LF for an empty string', () => {
    expect(detectLineEnding('')).toBe('LF')
  })

  it('returns LF when no newline is present', () => {
    expect(detectLineEnding('single line')).toBe('LF')
  })

  it('returns LF for a pure-LF document', () => {
    expect(detectLineEnding('a\nb\nc\n')).toBe('LF')
  })

  it('returns CRLF for a pure-CRLF document', () => {
    expect(detectLineEnding('a\r\nb\r\nc\r\n')).toBe('CRLF')
  })

  it('returns CR for a classic-Mac document', () => {
    expect(detectLineEnding('a\rb\rc\r')).toBe('CR')
  })

  it('does not double-count CRLF as CR + LF', () => {
    // Two CRLF lines and zero bare CRs — should be CRLF, not CR.
    expect(detectLineEnding('first\r\nsecond\r\n')).toBe('CRLF')
  })

  it('returns CRLF when CRLF dominates a mixed buffer', () => {
    // 3 CRLF, 1 LF, 0 CR -> CRLF wins.
    expect(detectLineEnding('a\r\nb\r\nc\r\nd\ne')).toBe('CRLF')
  })

  it('returns LF when LF dominates a mixed buffer', () => {
    // 4 LF, 1 CRLF -> LF wins.
    expect(detectLineEnding('a\nb\nc\nd\ne\r\n')).toBe('LF')
  })

  it('returns CR only when bare CR strictly outnumbers both LF and CRLF', () => {
    // 3 CR, 1 LF, 0 CRLF -> CR.
    expect(detectLineEnding('a\rb\rc\rd\n')).toBe('CR')
  })
})
