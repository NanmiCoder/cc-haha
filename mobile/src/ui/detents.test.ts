import { describe, expect, test } from 'bun:test'
import { detentFraction, detentHeight, settleDetent, sheetAvailable } from './detents'

describe('settleDetent', () => {
  test('Half height: slow short drags spring back, dragging far or flinging down closes, dragging far or flinging up expands', () => {
    expect(settleDetent({ level: 'half', dy: 20, vy: 0.1 })).toBe('half')
    expect(settleDetent({ level: 'half', dy: -20, vy: -0.1 })).toBe('half')
    expect(settleDetent({ level: 'half', dy: 90, vy: 0.1 })).toBe('close')
    expect(settleDetent({ level: 'half', dy: 10, vy: 1.4 })).toBe('close')
    expect(settleDetent({ level: 'half', dy: -90, vy: 0 })).toBe('full')
    expect(settleDetent({ level: 'half', dy: -10, vy: -1.4 })).toBe('full')
  })

  test('Full height: dragging or flinging down goes back to half instead of closing; dragging up stays full', () => {
    expect(settleDetent({ level: 'full', dy: 90, vy: 0 })).toBe('half')
    expect(settleDetent({ level: 'full', dy: 5, vy: 1.2 })).toBe('half')
    expect(settleDetent({ level: 'full', dy: -120, vy: -2 })).toBe('full')
    expect(settleDetent({ level: 'full', dy: 20, vy: 0.2 })).toBe('full')
  })

  test('With only one detent dragging up does not expand', () => {
    expect(settleDetent({ level: 'half', dy: -200, vy: -2, allowFull: false })).toBe('half')
    expect(settleDetent({ level: 'half', dy: 200, vy: 2, allowFull: false })).toBe('close')
  })
})

describe('detentHeight', () => {
  test('Proportional to available height, never negative', () => {
    expect(detentHeight('half', 800)).toBe(Math.round(800 * detentFraction.half))
    expect(detentHeight('full', 800)).toBe(Math.round(800 * detentFraction.full))
    expect(detentHeight('half', -10)).toBe(0)
  })
})

describe('sheetAvailable', () => {
  test('Subtract the status bar and top margin', () => {
    expect(sheetAvailable(844, 47)).toBe(844 - 47 - 8)
  })

  test('Never negative when the keyboard shrinks the visible area a lot', () => {
    expect(sheetAvailable(300, 47)).toBe(245)
    expect(sheetAvailable(40, 47)).toBe(0)
  })
})
