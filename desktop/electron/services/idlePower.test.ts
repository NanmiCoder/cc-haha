// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdlePowerService, readIdlePowerActivity } from './idlePower'
import { DEFAULT_IDLE_POWER_SETTINGS } from '../../src/lib/idlePower'

// Both Bun's native lane and Vitest run these tests. Flush promises between
// timer steps because Bun does not expose advanceTimersByTimeAsync.
async function advanceTime(milliseconds: number): Promise<void> {
  let remaining = milliseconds
  do {
    const step = Math.min(remaining, 100)
    vi.advanceTimersByTime(step)
    for (let i = 0; i < 16; i++) await Promise.resolve()
    remaining -= step
  } while (remaining > 0)
}

const services: IdlePowerService[] = []
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers() })
async function fixture() {
  vi.useFakeTimers()
  let snapshot = { epoch: 'server-a', revision: 0, busy: false, completionSequence: 0, scheduledCompletionSequence: 0 }
  let lastInputAt = Date.now() - 100_000
  const dispatch = vi.fn()
  const execute = vi.fn(async (_action: string, beforeExecute: () => Promise<void>) => { await beforeExecute(); dispatch() })
  const save = vi.fn()
  const notify = vi.fn(() => true)
  const readActivity = vi.fn(async () => ({ ...snapshot }))
  const service = new IdlePowerService({
    settings: { ...DEFAULT_IDLE_POWER_SETTINGS, action: 'sleep', countdownSeconds: 30 },
    lastAction: null,
    capabilities: { lock: true, sleep: true, hibernate: false, shutdown: true },
    readActivity, execute, save, notifyCountdown: notify, notifyNotice: vi.fn(), onChange: vi.fn(),
    getIdleSeconds: () => Math.floor((Date.now() - lastInputAt) / 1000), pollIntervalMs: 100, quietPeriodMs: 500,
  })
  services.push(service)
  service.start()
  await advanceTime(0)
  return { service, execute, dispatch, save, notify, readActivity,
    snapshot: (value: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...value } },
    input: () => { lastInputAt = Date.now() },
    complete: () => { snapshot = { ...snapshot, revision: snapshot.revision + 2, completionSequence: snapshot.completionSequence + 1 } },
  }
}

describe('all-idle power completion edge', () => {
  it('does not replay startup history; notifies after quiet then rechecks once before execution', async () => {
    const f = await fixture()
    await advanceTime(60_000)
    expect(f.dispatch).not.toHaveBeenCalled()
    f.complete()
    await advanceTime(700)
    expect(f.service.getState().countdown?.action).toBe('sleep')
    expect(f.notify).toHaveBeenCalledTimes(1)
    await advanceTime(30_100)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ lastAction: expect.objectContaining({ result: 'requested' }) }))
    await advanceTime(60_000)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it.each(['busy', 'quick-work', 'epoch', 'unavailable', 'user', 'cancel'] as const)('cancels countdown on %s without replay', async reason => {
    const f = await fixture()
    f.complete()
    await advanceTime(700)
    expect(f.service.getState().countdown).not.toBeNull()
    if (reason === 'busy') f.snapshot({ revision: 3, busy: true })
    if (reason === 'quick-work') f.snapshot({ revision: 4, completionSequence: 2 })
    if (reason === 'epoch') f.snapshot({ epoch: 'server-b' })
    if (reason === 'unavailable') f.readActivity.mockRejectedValue(new Error('offline'))
    if (reason === 'user') f.input()
    if (reason === 'cancel') f.service.cancel()
    await advanceTime(40_000)
    expect(f.service.getState().countdown).toBeNull()
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('waits for every background task and pending decision, with a scoped scheduled completion', async () => {
    const f = await fixture()
    f.service.configure({ action: 'lock', scope: 'scheduled', countdownSeconds: 0 })
    await advanceTime(100)
    f.complete()
    await advanceTime(1000)
    expect(f.dispatch).not.toHaveBeenCalled()
    f.snapshot({ revision: 3, scheduledCompletionSequence: 1, busy: true })
    await advanceTime(1000)
    expect(f.dispatch).not.toHaveBeenCalled()
    f.snapshot({ revision: 4, busy: false })
    await advanceTime(700)
    expect(f.execute).toHaveBeenCalledWith('lock', expect.any(Function))
  })
  it('rejects unsupported settings, cancels a reconfiguration, and fails closed if notification or persistence fails', async () => {
    const f = await fixture()
    expect(() => f.service.configure({ action: 'hibernate', scope: 'any', countdownSeconds: 0 })).toThrow()
    f.complete()
    await advanceTime(700)
    f.service.configure({ action: 'none', scope: 'any', countdownSeconds: 60 })
    await advanceTime(40_000)
    expect(f.dispatch).not.toHaveBeenCalled()
    f.service.configure({ action: 'sleep', scope: 'any', countdownSeconds: 0 })
    await advanceTime(100)
    f.notify.mockReturnValue(false)
    f.complete()
    await advanceTime(700)
    expect(f.dispatch).not.toHaveBeenCalled()
    f.notify.mockReturnValue(true)
    f.save.mockImplementation(() => { throw new Error('disk full') })
    f.complete()
    await advanceTime(700)
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('rechecks after asynchronous platform preparation and refuses new work even at zero countdown', async () => {
    const f = await fixture()
    f.service.configure({ action: 'sleep', scope: 'any', countdownSeconds: 0 })
    await advanceTime(100)
    f.execute.mockImplementation(async (_action, beforeExecute) => {
      f.snapshot({ busy: true, revision: 3 })
      await beforeExecute()
      f.dispatch()
    })
    f.complete()
    await advanceTime(700)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.service.getState().notice).toBe('new-work')
  })
  it('records native failures once, and never retries an already consumed completion', async () => {
    const f = await fixture()
    f.execute.mockImplementation(async (_action, beforeExecute) => {
      await beforeExecute()
      throw new Error('OS refused the action')
    })
    f.complete()
    await advanceTime(40_000)
    expect(f.service.getState()).toMatchObject({ countdown: null, notice: 'failed', lastAction: { result: 'failed' } })
    expect(f.execute).toHaveBeenCalledTimes(1)
    await advanceTime(40_000)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('invalidates an asynchronous platform preparation when the user disables the feature', async () => {
    const f = await fixture()
    let release!: () => void
    f.execute.mockImplementation(async (_action, beforeExecute) => {
      await new Promise<void>(resolve => { release = resolve })
      await beforeExecute()
      f.dispatch()
    })
    f.complete()
    await advanceTime(31_000)
    expect(f.execute).toHaveBeenCalledTimes(1)
    f.service.configure({ action: 'none', scope: 'any', countdownSeconds: 60 })
    release()
    await advanceTime(1000)
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('invalidates an in-flight final check on cancel/dispose and detects activity returned by that check', async () => {
    const f = await fixture()
    f.complete()
    await advanceTime(700)
    let finish!: (value: Awaited<ReturnType<typeof f.readActivity>>) => void
    f.readActivity.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await advanceTime(100)
    f.service.dispose()
    finish({ epoch: 'server-a', revision: 2, busy: false, completionSequence: 1, scheduledCompletionSequence: 0 })
    await advanceTime(40_000)
    expect(f.dispatch).not.toHaveBeenCalled()
  })
})

describe('power activity transport', () => {
  it('requires a fresh valid authenticated snapshot and never treats failure as idle', async () => {
    const request = vi.fn(async () => Response.json({ epoch: 'fixture', revision: 2, busy: false, completionSequence: 1, scheduledCompletionSequence: 0 }))
    const access = { serverUrl: 'http://127.0.0.1:1234', token: 'fixture-token' }
    const signal = AbortSignal.timeout(1000)
    await expect(readIdlePowerActivity(access, signal, request as typeof fetch)).resolves.toMatchObject({ busy: false })
    expect(request).toHaveBeenCalledWith(`${access.serverUrl}/api/sessions/power-activity`, expect.objectContaining({ headers: { Authorization: 'Bearer fixture-token' }, signal, redirect: 'error' }))
    await expect(readIdlePowerActivity(null, signal, request as typeof fetch)).rejects.toThrow()
    for (const data of [{}, { epoch: 'x', busy: false }, { epoch: 'x', revision: -1, busy: false, completionSequence: 0, scheduledCompletionSequence: 0 }]) {
      request.mockResolvedValue(Response.json(data))
      await expect(readIdlePowerActivity(access, signal, request as typeof fetch)).rejects.toThrow()
    }
    request.mockResolvedValue(new Response('', { status: 503 }))
    await expect(readIdlePowerActivity(access, signal, request as typeof fetch)).rejects.toThrow()
  })
})
