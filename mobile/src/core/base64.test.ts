import { afterEach, expect, test } from 'bun:test'
import { base64ToBytes, bytesToBase64 } from './base64'

const sample = (length: number) =>
  Uint8Array.from({ length }, (_, i) => (i * 131 + (i >> 7) * 17 + 7) & 255)
const platform = { atob: globalThis.atob, btoa: globalThis.btoa }
afterEach(() => {
  globalThis.atob = platform.atob
  globalThis.btoa = platform.btoa
})

test('uses the platform atob/btoa (Hermes and browsers have them) instead of a per-character loop', () => {
  let encodes = 0
  let decodes = 0
  globalThis.btoa = (text: string) => {
    encodes++
    return platform.btoa(text)
  }
  globalThis.atob = (text: string) => {
    decodes++
    return platform.atob(text)
  }
  const bytes = sample(300_000)
  const text = bytesToBase64(bytes)
  expect(text).toBe(Buffer.from(bytes).toString('base64'))
  expect([...base64ToBytes(text)]).toEqual([...bytes])
  expect(encodes).toBeGreaterThan(0)
  expect(decodes).toBeGreaterThan(0)
})

test('without atob/btoa the pure-JS fallback gives the same bytes at every length and padding', () => {
  const lengths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 255, 256, 257, 3 * 4096 - 1, 3 * 4096, 3 * 4096 + 1, 70_000]
  const fast = lengths.map((length) => bytesToBase64(sample(length)))
  globalThis.atob = undefined as never
  globalThis.btoa = undefined as never
  lengths.forEach((length, index) => {
    const bytes = sample(length)
    expect(bytesToBase64(bytes)).toBe(fast[index]!)
    expect(fast[index]!).toBe(Buffer.from(bytes).toString('base64'))
    expect([...base64ToBytes(fast[index]!)]).toEqual([...bytes])
  })
  const every = Uint8Array.from({ length: 256 }, (_, i) => i)
  expect([...base64ToBytes(bytesToBase64(every))]).toEqual([...every])
})
