// @vitest-environment node
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPreventSleepLifecycle, PreventSleepService, readPreventSleepActivity } from './preventSleep'
import { installMainWindowNavigationGuards } from './navigationGuards'

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Prevent-sleep state did not settle')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

describe('prevent sleep main-process lifecycle', () => {
  const services: PreventSleepService[] = []
  function create(readActivity = vi.fn(async (_signal: AbortSignal) => false)) {
    let nextId = 0
    const blocker = { start: vi.fn(() => nextId++), stop: vi.fn(() => true) }
    const onError = vi.fn()
    const service = new PreventSleepService({ blocker, readActivity, onError, pollIntervalMs: 5 })
    services.push(service)
    return { service, blocker, readActivity, onError }
  }
  afterEach(() => { for (const service of services.splice(0)) service.dispose() })

  it('defaults off, never blocks an idle machine, and deduplicates enabling', async () => {
    const { service, blocker, readActivity } = create()
    expect(readActivity).not.toHaveBeenCalled()
    service.setEnabled(true)
    service.setEnabled(true)
    await until(() => readActivity.mock.calls.length >= 2)
    expect(blocker.start).not.toHaveBeenCalled()
    service.setEnabled(false)
    expect(blocker.stop).not.toHaveBeenCalled()
  })

  it('holds one system-only blocker across active sessions and releases on the final task or opt-out', async () => {
    let active = true
    const { service, blocker, readActivity } = create(vi.fn(async () => active))
    service.setEnabled(true)
    await until(() => readActivity.mock.calls.length >= 2)
    expect(blocker.start.mock.calls).toEqual([['prevent-app-suspension']])
    active = false
    await until(() => blocker.stop.mock.calls.length === 1)
    expect(blocker.stop).toHaveBeenLastCalledWith(0)
    active = true
    await until(() => blocker.start.mock.calls.length === 2)
    service.setEnabled(false)
    expect(blocker.stop).toHaveBeenLastCalledWith(1)
  })

  it('aborts an old request and ignores its late reply after disable/re-enable', async () => {
    let finish: (active: boolean) => void = () => {}
    const readActivity = vi.fn((_signal: AbortSignal) => Promise.resolve(false))
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { service, blocker } = create(readActivity)
    service.setEnabled(true)
    const oldSignal = readActivity.mock.calls[0]![0]
    service.setEnabled(false)
    expect(oldSignal.aborted).toBe(true)
    service.setEnabled(true)
    finish(true)
    await until(() => readActivity.mock.calls.length >= 3)
    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('releases a stale blocker when the server fails, deduplicates errors, and recovers', async () => {
    let fail = false
    const { service, blocker, readActivity, onError } = create(vi.fn(async () => {
      if (fail) throw new Error('fixture server unavailable')
      return true
    }))
    service.setEnabled(true)
    await until(() => blocker.start.mock.calls.length === 1)
    fail = true
    const before = readActivity.mock.calls.length
    await until(() => readActivity.mock.calls.length >= before + 3)
    expect(blocker.stop).toHaveBeenCalledWith(0)
    expect(onError).toHaveBeenCalledTimes(1)
    fail = false
    await until(() => blocker.start.mock.calls.length === 2)
    service.dispose()
    expect(blocker.stop).toHaveBeenLastCalledWith(1)
    const polls = readActivity.mock.calls.length
    service.setEnabled(true)
    expect(readActivity).toHaveBeenCalledTimes(polls)
  })

  it('does not acquire a blocker from a request that finishes after quit', async () => {
    let finish: (active: boolean) => void = () => {}
    const { service, blocker } = create(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve })))
    service.setEnabled(true)
    service.dispose()
    finish(true)
    await Promise.resolve()
    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('keeps the active blocker and polling when the main window cancels an external navigation', async () => {
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() })
    const { service, blocker, readActivity } = create(vi.fn(async () => true))
    const openExternal = vi.fn()
    const preventDefault = vi.fn()
    installMainWindowNavigationGuards(contents, { openExternal })
    installPreventSleepLifecycle(contents as unknown as WebContents, service)
    service.setEnabled(true)
    await until(() => readActivity.mock.calls.length >= 2)

    // Chromium emits the start before will-navigate's guard cancels it. The
    // original document survives, so its startup restore will not run again.
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, 'https://example.test')
    contents.emit('will-navigate', { preventDefault }, 'https://example.test')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.test')
    expect(blocker.stop).not.toHaveBeenCalled()
    const polls = readActivity.mock.calls.length
    await until(() => readActivity.mock.calls.length > polls)
    expect(blocker.start).toHaveBeenCalledTimes(1)
  })

  it('releases on committed main-document replacement, crash and destruction only', () => {
    const contents = new EventEmitter()
    const setEnabled = vi.fn()
    installPreventSleepLifecycle(contents as unknown as WebContents, { setEnabled })
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    contents.emit('did-navigate-in-page', {}, 'app://index.html#settings', true)
    contents.emit('did-frame-navigate', {}, 'https://example.test', 200, 'OK', false)
    expect(setEnabled).not.toHaveBeenCalled()
    // did-navigate is main-frame only and excludes in-page navigation.
    contents.emit('did-navigate', {}, 'app://index.html', 200, 'OK')
    contents.emit('render-process-gone')
    contents.emit('destroyed')
    expect(setEnabled.mock.calls).toEqual([[false], [false], [false]])
  })
})

describe('prevent sleep activity transport', () => {
  const access = { serverUrl: 'http://127.0.0.1:12345', token: 'fixture-token' }
  const signal = new AbortController().signal

  it('reads the authenticated aggregate endpoint, including unseen background/remote sessions and approvals', async () => {
    const requestMock = vi.fn().mockResolvedValue(Response.json({ sessions: [
      { id: 'idle', activityState: 'idle' },
      { id: 'remote', activityState: 'running' },
    ] }))
    const request = requestMock as unknown as typeof fetch
    expect(await readPreventSleepActivity(access, signal, request)).toBe(true)
    expect(request).toHaveBeenCalledWith(`${access.serverUrl}/api/sessions/live-status?includeTeamWorkers=1`, {
      headers: { Authorization: 'Bearer fixture-token' }, signal, redirect: 'error',
    })
    requestMock.mockResolvedValue(Response.json({ sessions: [{ id: 'approval', activityState: 'waiting' }] }))
    expect(await readPreventSleepActivity(access, signal, request)).toBe(true)
    requestMock.mockResolvedValue(Response.json({ sessions: [] }))
    expect(await readPreventSleepActivity(access, signal, request)).toBe(false)
    expect(await readPreventSleepActivity(null, signal, request)).toBe(false)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('rejects HTTP errors and malformed snapshots instead of treating them as active work', async () => {
    const requestMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const request = requestMock as unknown as typeof fetch
    await expect(readPreventSleepActivity(access, signal, request)).rejects.toThrow('activity unavailable')
    for (const body of [null, {}, { sessions: true }]) {
      requestMock.mockResolvedValue(Response.json(body))
      await expect(readPreventSleepActivity(access, signal, request)).rejects.toThrow('Invalid session activity')
    }
  })
})
