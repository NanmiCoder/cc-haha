import { describe, expect, it } from 'vitest'
import { isBrowserSafePort } from './browserSafePort'

const WHATWG_FETCH_BLOCKED_PORTS = [
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
  69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514,
  515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]

describe('browser-safe desktop ports', () => {
  it('rejects the complete WHATWG Fetch bad-port table', () => {
    for (const port of WHATWG_FETCH_BLOCKED_PORTS) {
      expect(isBrowserSafePort(port), `port ${port}`).toBe(false)
    }
  })

  it('accepts valid ports outside the blocked table', () => {
    for (const port of [80, 3456, 5062, 28670, 65535]) {
      expect(isBrowserSafePort(port), `port ${port}`).toBe(true)
    }
    expect(isBrowserSafePort(-1)).toBe(false)
    expect(isBrowserSafePort(1.5)).toBe(false)
    expect(isBrowserSafePort(65536)).toBe(false)
  })
})
