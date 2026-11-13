import { describe, expect, it } from 'bun:test'
import { WechatRuntimeService } from '../services/wechatRuntimeService.js'

describe('WeChat runtime health', () => {
  it('expires a stalled poll even if the local heartbeat continues', () => {
    let now = 1000
    const service = new WechatRuntimeService(() => now)
    const { leaseId } = service.register('worker', now)!
    service.report(leaseId, { state: 'online', lastPollOkAt: now })
    now += 46_000
    service.report(leaseId, { state: 'online', lastPollOkAt: 1000 })
    expect(service.getSnapshot()).toMatchObject({ state: 'stale', serverReachable: true })
  })
  it('requires a fresh report and expires stale health without persisting online state', () => {
    let now = 1000
    const service = new WechatRuntimeService(() => now)
    expect(service.getSnapshot().state).toBe('stopped')
    const { leaseId } = service.register('worker', now)!
    expect(service.getSnapshot().state).toBe('starting')
    service.report(leaseId, { state: 'online', lastPollOkAt: now, lastReceiveAt: now })
    expect(service.getSnapshot().state).toBe('online')
    now += 45_001
    expect(service.getSnapshot()).toMatchObject({ state: 'stale', serverReachable: false, lastReceiveAt: 1000 })
    expect(new WechatRuntimeService().getSnapshot().state).toBe('stopped')
  })

  it('rejects late reports from replaced and invalidated workers', () => {
    const service = new WechatRuntimeService(() => 1000)
    const old = service.register('old', 1)!
    const current = service.register('current', 2)!
    expect(service.report(old.leaseId, { state: 'online' })).toBe(false)
    expect(service.getSnapshot().state).toBe('starting')
    expect(service.report(current.leaseId, { state: 'reconnecting', errorCode: 'NETWORK' })).toBe(true)
    service.invalidate()
    expect(service.report(current.leaseId, { state: 'online' })).toBe(false)
    expect(service.getSnapshot().state).toBe('stopped')
  })
  it('fences delayed registration and makes a same-instance registration retry idempotent', () => {
    let now = 1000
    const service = new WechatRuntimeService(() => now)
    const first = service.register('first', 1000)!
    expect(service.register('first', 1000)).toEqual(first)
    now = 2000
    const second = service.register('second', 2000)!
    expect(service.register('first', 1000)).toBeNull()
    expect(service.register('third', 2000)).toBeNull()
    expect(service.report(second.leaseId, { state: 'starting' })).toBe(true)
    now = 3000
    service.invalidate()
    expect(service.register('second', 2000)).toBeNull()
    expect(service.register('delayed', 2500)).toBeNull()
    expect(service.register('replacement', 3000)).not.toBeNull()
  })
})
