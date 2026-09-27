import { beforeEach, describe, it, expect } from 'vitest'
import {
  __virtualHeightCacheInternals,
  dropSession,
  getHeightsForSession,
  getMetricsForSession,
} from './virtualHeightCache'

describe('virtualHeightCache', () => {
  beforeEach(() => {
    __virtualHeightCacheInternals.reset()
  })

  it('returns the same map instance across calls for the same session', () => {
    const a = getHeightsForSession('session-a')
    a.set('msg-1', 100)
    const aAgain = getHeightsForSession('session-a')
    expect(aAgain).toBe(a)
    expect(aAgain.get('msg-1')).toBe(100)
  })

  it('isolates per-session entries', () => {
    getHeightsForSession('s1').set('x', 42)
    getHeightsForSession('s2').set('x', 99)
    expect(getHeightsForSession('s1').get('x')).toBe(42)
    expect(getHeightsForSession('s2').get('x')).toBe(99)
  })

  it('invalidates an inactive session on return after reading preferences change', () => {
    const first = getHeightsForSession('first', 'system:14:standard')
    first.set('row', 200)
    getHeightsForSession('second', 'system:14:standard').set('row', 300)
    getHeightsForSession('second', 'serif:24:wide')
    expect(getHeightsForSession('first', 'serif:24:wide')).toBe(first)
    expect(first.size).toBe(0)
    first.set('row', 400)
    expect(getHeightsForSession('first', 'serif:24:wide').get('row')).toBe(400)
  })

  it('evicts the least recently used session beyond the LRU bound', () => {
    for (let i = 0; i < 18; i++) {
      getHeightsForSession(`session-${i}`).set('marker', i)
    }
    expect(__virtualHeightCacheInternals.size()).toBe(16)
    // session-0 should have been evicted (oldest, never re-touched)
    const restored = getHeightsForSession('session-0')
    expect(restored.size).toBe(0)
  })

  it('dropSession removes both height and metric maps', () => {
    getHeightsForSession('s').set('a', 1)
    getMetricsForSession('s').set('a', { signature: 'sig', contentWeight: 10, estimatedHeight: 20 })

    dropSession('s')

    expect(getHeightsForSession('s').size).toBe(0)
    expect(getMetricsForSession('s').size).toBe(0)
  })

  it('switching back to a previously visited session preserves measurements', () => {
    const original = getHeightsForSession('long-session')
    original.set('item-1', 240)
    original.set('item-2', 360)

    // simulate switching to another session, then back
    getHeightsForSession('other-session').set('item-1', 100)
    const restored = getHeightsForSession('long-session')

    expect(restored.get('item-1')).toBe(240)
    expect(restored.get('item-2')).toBe(360)
  })
})
