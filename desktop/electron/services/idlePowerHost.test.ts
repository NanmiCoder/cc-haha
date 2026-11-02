// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdlePowerHost, installIdlePowerLifecycle } from './idlePowerHost'
import { readIdlePowerPreferences } from './idlePowerPersistence'
import type { IdlePowerService } from './idlePower'

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
const homes: string[] = []
afterEach(() => {
  services.splice(0).forEach(service => service.dispose())
  homes.splice(0).forEach(home => rmSync(home, { force: true, recursive: true }))
  vi.useRealTimers()
})

async function fixture() {
  vi.useFakeTimers({ now: 100_000 })
  const home = mkdtempSync(path.join(tmpdir(), 'idle-power-host-'))
  homes.push(home)
  const notifications: FakeNotification[] = []
  class FakeNotification extends EventEmitter {
    static isSupported() { return true }
    constructor(readonly options: { title: string, body?: string }) { super(); notifications.push(this) }
    show() {}
  }
  let snapshot = { epoch: 'fixture', revision: 0, busy: false, completionSequence: 0, scheduledCompletionSequence: 0 }
  const dispatch = vi.fn()
  const app = { getPath: (_name: 'userData') => home }
  const options = {
    app,
    blocker: { start: vi.fn(() => 1), stop: vi.fn(() => true) },
    NotificationClass: FakeNotification,
    locale: () => 'zh' as const,
    monitor: { getSystemIdleTime: () => Math.floor(Date.now() / 1000) },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    readActivity: vi.fn(async () => ({ ...snapshot })),
    onChange: vi.fn(),
    detectCapabilities: async () => ({ lock: true, sleep: true, hibernate: false, shutdown: true }),
    executeAction: vi.fn(async (_action, deps) => { await deps?.beforeExecute?.(); dispatch() }) as NonNullable<Parameters<typeof createIdlePowerHost>[0]['executeAction']>,
  }
  const service = await createIdlePowerHost(options)
  services.push(service)
  return { service, options, notifications, dispatch,
    complete: () => { snapshot = { ...snapshot, revision: snapshot.revision + 2, completionSequence: snapshot.completionSequence + 1 } },
  }
}

describe('native idle-power integration with mocked OS and notification boundary', () => {
  it('persists an explicit selection, delivers a cancellable notification and restores a truthful last-action reminder', async () => {
    const f = await fixture()
    expect(f.service.getState().settings.action).toBe('none')
    f.service.configure({ action: 'shutdown', scope: 'any', countdownSeconds: 30 })
    await advanceTime(0)
    f.complete()
    await advanceTime(6000)
    expect(f.options.blocker.start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(f.notifications[0]!.options.body).toContain('30')
    expect(f.notifications[0]!.options.body).toContain('关机')
    f.notifications[0]!.emit('click')
    await advanceTime(31_000)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.service.getState().notice).toBe('cancelled')
    expect(f.options.blocker.stop).toHaveBeenCalledTimes(1)
    f.complete()
    await advanceTime(37_000)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(readIdlePowerPreferences(f.options.app).lastAction).toMatchObject({ action: 'shutdown', result: 'accepted' })
    f.service.dispose()
    const restarted = await createIdlePowerHost(f.options)
    services.push(restarted)
    await advanceTime(60_000)
    expect(restarted.getState().lastAction?.result).toBe('accepted')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('cancels a failed notification and native keyboard event, and stops on renderer replacement', async () => {
    const f = await fixture()
    const contents = new EventEmitter()
    installIdlePowerLifecycle(contents as unknown as WebContents, () => f.service)
    f.service.configure({ action: 'sleep', scope: 'any', countdownSeconds: 30 })
    await advanceTime(0)
    f.complete()
    await advanceTime(6000)
    f.notifications[0]!.emit('failed')
    expect(f.service.getState().notice).toBe('unavailable')
    f.complete()
    await advanceTime(6000)
    contents.emit('before-input-event', {}, { type: 'keyDown' })
    expect(f.service.getState().notice).toBe('user-activity')
    f.complete()
    await advanceTime(6000)
    contents.emit('render-process-gone')
    await advanceTime(60_000)
    expect(f.dispatch).not.toHaveBeenCalled()
  })
})
