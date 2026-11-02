// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdlePowerService } from './idlePower'
import { PreventSleepService } from './preventSleep'

async function advance(milliseconds: number) {
  let remaining = milliseconds
  do {
    const step = Math.min(remaining, 100)
    vi.advanceTimersByTime(step)
    for (let i = 0; i < 16; i++) await Promise.resolve()
    remaining -= step
  } while (remaining > 0)
}
const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.useRealTimers() })
async function fixture(options: { action?: 'sleep' | 'none', scope?: 'any' | 'scheduled', start?: boolean } = {}) {
  vi.useFakeTimers({ now: 100_000 })
  let snapshot = { epoch: 'fixture', revision: 0, busy: true, completionSequence: 0, scheduledCompletionSequence: 0 }
  let nextId = 0
  const active = new Set<number>()
  const events: string[] = []
  const blocker = {
    start: vi.fn(() => { const id = nextId++; active.add(id); events.push(`start:${id}`); return id }),
    stop: vi.fn((id: number) => { active.delete(id); events.push(`stop:${id}`); return true }),
  }
  let prepareGate = Promise.resolve()
  let activeAtDispatch: number | undefined
  const dispatch = vi.fn(() => { activeAtDispatch = active.size; events.push('dispatch') })
  const execute = vi.fn(async (_action: string, beforeExecute: () => Promise<void>) => {
    events.push('prepare')
    await prepareGate
    await beforeExecute()
    dispatch()
  })
  const readActivity = vi.fn(async () => ({ ...snapshot }))
  const save = vi.fn()
  const notify = vi.fn(() => true)
  const service = new IdlePowerService({
    settings: { action: options.action ?? 'sleep', scope: options.scope ?? 'any', countdownSeconds: 60 },
    blocker,
    lastAction: null, capabilities: { lock: true, sleep: true, hibernate: false, shutdown: true },
    readActivity, execute, save, notifyCountdown: notify, notifyNotice: vi.fn(), onChange: vi.fn(),
    getIdleSeconds: () => Math.floor(Date.now() / 1000), pollIntervalMs: 1000,
  })
  const beforeIdleRelease = vi.fn(() => service.prepareIdleHandoff())
  const preventRead = vi.fn(async () => snapshot.busy)
  const prevent = new PreventSleepService({
    blocker, beforeIdleRelease, readActivity: preventRead, onError: vi.fn(), pollIntervalMs: 1000,
  })
  cleanup.push(() => service.dispose(), () => prevent.dispose())
  if (options.start !== false) {
    service.start()
    prevent.setEnabled(true)
    await advance(0)
  }
  return { service, prevent, blocker, beforeIdleRelease, preventRead, readActivity, execute, save, notify,
    active, events, dispatch, activeAtDispatch: () => activeAtDispatch,
    snapshot: (change: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...change } },
    complete: () => { snapshot = { ...snapshot, busy: false, revision: snapshot.revision + 2, completionSequence: snapshot.completionSequence + 1 } },
    deferPreparation: () => { let release!: () => void; prepareGate = new Promise<void>(resolve => { release = resolve }); return release },
  }
}

describe('continuous task-to-idle power assertion handoff', () => {
  it('overlaps assertions and stays awake for quiet, countdown and preparation, then releases before dispatch', async () => {
    const f = await fixture()
    const release = f.deferPreparation()
    f.complete()
    await advance(1100)
    expect(f.beforeIdleRelease).toHaveBeenCalledTimes(1)
    expect(f.events.slice(0, 3)).toEqual(['start:0', 'start:1', 'stop:0'])
    expect(f.active.size).toBe(1)
    expect(f.service.getState().countdown).toBeNull()
    await advance(6000)
    expect(f.active.size).toBe(1)
    expect(f.service.getState().countdown?.action).toBe('sleep')
    await advance(61_000)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.active.size).toBe(1)
    expect(f.dispatch).not.toHaveBeenCalled()
    release()
    await advance(0)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.activeAtDispatch()).toBe(0)
    expect(f.service.getState().lastAction?.result).toBe('accepted')
  })

  it('ignores a busy read started before handoff instead of dropping the new assertion', async () => {
    const f = await fixture()
    let finish!: (snapshot: Awaited<ReturnType<typeof f.readActivity>>) => void
    f.readActivity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await advance(1000)
    f.complete()
    await advance(1100)
    expect(f.active.size).toBe(1)
    finish({ epoch: 'fixture', revision: 0, busy: true, completionSequence: 0, scheduledCompletionSequence: 0 })
    await advance(100)
    expect(f.active.size).toBe(1)
    await advance(6000)
    expect(f.service.getState().countdown?.action).toBe('sleep')
  })

  it('invalidates a second-cycle busy read even when the previous completion already owns an assertion', async () => {
    const f = await fixture()
    f.complete()
    await advance(1100)
    expect(f.active.size).toBe(1)
    f.snapshot({ busy: true, revision: 3 })
    let finish!: (snapshot: Awaited<ReturnType<typeof f.readActivity>>) => void
    f.readActivity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await advance(1000)
    expect(f.active.size).toBe(2)
    f.complete()
    await advance(900)
    expect(f.active.size).toBe(1)
    finish({ epoch: 'fixture', revision: 3, busy: true, completionSequence: 1, scheduledCompletionSequence: 0 })
    await advance(0)
    expect(f.active.size).toBe(1)
    await advance(6000)
    expect(f.service.getState().countdown?.action).toBe('sleep')
  })

  it('releases provisional ownership when only an out-of-scope completion occurred', async () => {
    const f = await fixture({ scope: 'scheduled' })
    f.complete()
    await advance(1100)
    expect(f.beforeIdleRelease).toHaveBeenCalledTimes(1)
    expect(f.blocker.start).toHaveBeenCalledTimes(2)
    expect(f.active.size).toBe(0)
    await advance(70_000)
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('validates a fresh baseline without replaying startup completion history', async () => {
    const f = await fixture({ start: false })
    f.snapshot({ busy: false, revision: 20, completionSequence: 9 })
    f.service.start()
    f.service.prepareIdleHandoff()
    expect(f.active.size).toBe(1)
    await advance(100)
    expect(f.active.size).toBe(0)
    await advance(70_000)
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('does not acquire an assertion while the feature is disabled or stopped', async () => {
    const disabled = await fixture({ action: 'none', start: false })
    disabled.service.start()
    disabled.service.prepareIdleHandoff()
    expect(disabled.active.size).toBe(0)
    const stopped = await fixture({ start: false })
    stopped.service.prepareIdleHandoff()
    expect(stopped.active.size).toBe(0)
  })

  it.each(['cancel', 'stop', 'dispose', 'configure', 'busy', 'epoch', 'read-error', 'notification', 'journal', 'platform'] as const)('releases on %s and never dispatches stale work', async reason => {
    const f = await fixture()
    f.complete()
    await advance(1100)
    expect(f.active.size).toBe(1)
    if (reason === 'cancel') f.service.cancel()
    if (reason === 'stop') f.service.stop()
    if (reason === 'dispose') f.service.dispose()
    if (reason === 'configure') f.service.configure({ action: 'none', scope: 'any', countdownSeconds: 60 })
    if (reason === 'busy') { f.snapshot({ busy: true, revision: 3 }); f.prevent.setEnabled(false) }
    if (reason === 'epoch') f.snapshot({ epoch: 'new-server' })
    if (reason === 'read-error') f.readActivity.mockRejectedValue(new Error('offline'))
    if (reason === 'notification') f.notify.mockReturnValue(false)
    if (reason === 'journal') f.save.mockImplementation(() => { throw new Error('disk full') })
    if (reason === 'platform') f.execute.mockRejectedValue(new Error('probe failed'))
    await advance(70_000)
    expect(f.active.size).toBe(0)
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('holds protection through an in-flight final activity check, releasing when it detects new work', async () => {
    const f = await fixture()
    let finish!: (snapshot: Awaited<ReturnType<typeof f.readActivity>>) => void
    f.execute.mockImplementation(async (_action, beforeExecute) => {
      f.readActivity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      await beforeExecute()
      f.dispatch()
    })
    f.complete()
    await advance(70_000)
    expect(f.active.size).toBe(1)
    finish({ epoch: 'fixture', revision: 3, busy: true, completionSequence: 1, scheduledCompletionSequence: 0 })
    await advance(0)
    expect(f.active.size).toBe(0)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.service.getState().notice).toBe('new-work')
  })

  it('does not reacquire from a delayed task release after the final dispatch check', async () => {
    const f = await fixture()
    f.execute.mockImplementation(async (_action, beforeExecute) => {
      await beforeExecute()
      f.service.prepareIdleHandoff()
      f.dispatch()
    })
    f.complete()
    await advance(70_000)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.activeAtDispatch()).toBe(0)
  })

  it('protects an observed completion even when task-time prevention is disabled', async () => {
    const f = await fixture({ start: false })
    f.service.start()
    await advance(0)
    f.complete()
    await advance(1100)
    expect(f.active.size).toBe(1)
    expect(f.beforeIdleRelease).not.toHaveBeenCalled()
    await advance(6000)
    expect(f.active.size).toBe(1)
    expect(f.service.getState().countdown?.action).toBe('sleep')
  })

  it('cancels manual suspend and resume without replaying the consumed completion', async () => {
    const f = await fixture()
    f.complete()
    await advance(7100)
    expect(f.service.getState().countdown).not.toBeNull()
    f.service.stop()
    expect(f.active.size).toBe(0)
    f.service.start()
    await advance(70_000)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.active.size).toBe(0)
  })

  it('cancels if a successor assertion cannot be created', async () => {
    const f = await fixture()
    f.blocker.start.mockImplementation(() => { throw new Error('assertion unavailable') })
    f.complete()
    await advance(70_000)
    expect(f.active.size).toBe(0)
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'failed'] as const)('does not invoke idle handoff when the active blocker is %s', async reason => {
    const f = await fixture()
    if (reason === 'disabled') f.prevent.setEnabled(false)
    else { f.preventRead.mockRejectedValue(new Error('offline')); await advance(1100) }
    expect(f.beforeIdleRelease).not.toHaveBeenCalled()
    expect(f.active.size).toBe(0)
  })
  it('invalidates old platform preparation on a later handoff and dispatches the fresh generation once', async () => {
    const f = await fixture()
    const release = f.deferPreparation()
    f.complete()
    await advance(70_000)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.active.size).toBe(1)
    f.service.prepareIdleHandoff()
    await advance(0)
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(f.active.size).toBe(1)
    release()
    await advance(0)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.active.size).toBe(0)
    expect(f.service.getState()).toMatchObject({ lastAction: { result: 'accepted' }, notice: null })
  })

  it('does not let an obsolete final-read response undo a newer handoff generation', async () => {
    const f = await fixture()
    let finish!: (snapshot: Awaited<ReturnType<typeof f.readActivity>>) => void
    f.execute.mockImplementationOnce(async (_action, beforeExecute) => {
      f.readActivity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      await beforeExecute()
      f.dispatch()
    })
    f.complete()
    await advance(70_000)
    expect(f.active.size).toBe(1)
    f.service.prepareIdleHandoff()
    await advance(0)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    finish({ epoch: 'fixture', revision: 2, busy: false, completionSequence: 1, scheduledCompletionSequence: 0 })
    await advance(0)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.active.size).toBe(0)
    expect(f.service.getState()).toMatchObject({ lastAction: { result: 'accepted' }, notice: null })
  })

})
