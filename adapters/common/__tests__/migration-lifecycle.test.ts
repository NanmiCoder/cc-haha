import { describe, expect, it } from 'bun:test'
import { AdapterMigrationLifecycle } from '../migration-lifecycle.js'

describe('adapter migration lifecycle', () => {
  it('closes ingress before teardown and waits for in-flight credential writes', async () => {
    const lifecycle = new AdapterMigrationLifecycle()
    let release!: () => void
    const calls: string[] = []
    lifecycle.track(new Promise<void>(resolve => { release = resolve }))
    lifecycle.registerShutdown(() => { expect(lifecycle.isQuiescing).toBe(true); calls.push('transport') })
    let completed = false
    const drain = lifecycle.quiesce().then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    await drain
    expect(calls).toEqual(['transport'])
  })

  it('does not acknowledge a failed pending write', async () => {
    const lifecycle = new AdapterMigrationLifecycle()
    let fail!: (error: Error) => void
    const pending = lifecycle.track(new Promise<void>((_resolve, reject) => { fail = reject }))
    void pending.catch(() => {})
    const drain = lifecycle.quiesce()
    fail(new Error('Cannot save credentials'))
    await expect(drain).rejects.toThrow('Cannot save credentials')
  })

  it('drains writes even when transport cleanup fails and closes each transport once', async () => {
    const lifecycle = new AdapterMigrationLifecycle()
    let release!: () => void
    let closed = 0
    lifecycle.track(new Promise<void>(resolve => { release = resolve }))
    lifecycle.registerShutdown(() => {
      closed++
      throw new Error('Transport close failed')
    })
    const stopping = lifecycle.quiesce()
    expect(lifecycle.quiesce()).toBe(stopping)
    let settled = false
    void stopping.catch(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await expect(stopping).rejects.toThrow('Transport close failed')
    expect(closed).toBe(1)
  })
})
