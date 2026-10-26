import { describe, expect, test } from 'bun:test'
import { detentFraction, detentHeight, settleDetent } from './detents'

describe('settleDetent', () => {
  test('半高：慢速短距离拖动回弹，向下拖远或甩动关闭，向上拖远或甩动展开', () => {
    expect(settleDetent({ level: 'half', dy: 20, vy: 0.1 })).toBe('half')
    expect(settleDetent({ level: 'half', dy: -20, vy: -0.1 })).toBe('half')
    expect(settleDetent({ level: 'half', dy: 90, vy: 0.1 })).toBe('close')
    expect(settleDetent({ level: 'half', dy: 10, vy: 1.4 })).toBe('close')
    expect(settleDetent({ level: 'half', dy: -90, vy: 0 })).toBe('full')
    expect(settleDetent({ level: 'half', dy: -10, vy: -1.4 })).toBe('full')
  })

  test('全高：向下拖或甩回半高而不是直接关闭，向上拖保持全高', () => {
    expect(settleDetent({ level: 'full', dy: 90, vy: 0 })).toBe('half')
    expect(settleDetent({ level: 'full', dy: 5, vy: 1.2 })).toBe('half')
    expect(settleDetent({ level: 'full', dy: -120, vy: -2 })).toBe('full')
    expect(settleDetent({ level: 'full', dy: 20, vy: 0.2 })).toBe('full')
  })

  test('只有一档时向上拖不会展开', () => {
    expect(settleDetent({ level: 'half', dy: -200, vy: -2, allowFull: false })).toBe('half')
    expect(settleDetent({ level: 'half', dy: 200, vy: 2, allowFull: false })).toBe('close')
  })
})

describe('detentHeight', () => {
  test('按可用高度取比例，不会为负', () => {
    expect(detentHeight('half', 800)).toBe(Math.round(800 * detentFraction.half))
    expect(detentHeight('full', 800)).toBe(Math.round(800 * detentFraction.full))
    expect(detentHeight('half', -10)).toBe(0)
  })
})
