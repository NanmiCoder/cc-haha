// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { ScriptTarget, transpile } from 'typescript'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import { createIdlePowerHost, installIdlePowerLifecycle } from './idlePowerHost'
import type { IdlePowerService } from './idlePower'

class Renderer extends EventEmitter {
  destroyed = false
  isDestroyed() { return this.destroyed }
  send = vi.fn(() => {
    if (this.destroyed) throw new TypeError('Object has been destroyed')
  })
  destroy() { this.destroyed = true; this.emit('destroyed') }
}

class Window {
  destroyed = false
  constructor(readonly webContents = new Renderer()) {}
  isDestroyed() { return this.destroyed }
}

const services: IdlePowerService[] = []
const homes: string[] = []
afterEach(() => {
  // A failing regression must not throw again during fixture cleanup.
  services.splice(0).forEach(service => {
    try { service.dispose() } catch { /* The test reports the original failure. */ }
  })
  homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true }))
  vi.useRealTimers()
})

async function advanceTime(milliseconds: number) {
  for (let elapsed = 0; elapsed <= milliseconds; elapsed += 100) {
    vi.advanceTimersByTime(elapsed === 0 ? 0 : 100)
    for (let turn = 0; turn < 16; turn++) await Promise.resolve()
  }
}

function fixture(pendingCapabilities?: Promise<{ lock: boolean, sleep: boolean, hibernate: boolean, shutdown: boolean }>) {
  vi.useFakeTimers({ now: 100_000 })
  const home = mkdtempSync(path.join(tmpdir(), 'idle-power-lifecycle-'))
  homes.push(home)
  const desktopDir = path.basename(process.cwd()) === 'desktop' ? process.cwd() : path.join(process.cwd(), 'desktop')
  const source = readFileSync(path.join(desktopDir, 'electron/main.ts'), 'utf8')
  const start = source.indexOf('async function getIdlePowerService()')
  const end = source.indexOf('const preventSleepService', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const window = new Window()
  let snapshot = { epoch: 'fixture', revision: 0, busy: false, completionSequence: 0, scheduledCompletionSequence: 0 }
  const blocker = { start: vi.fn(() => 1), stop: vi.fn(() => true) }
  const executeAction = vi.fn()
  const readActivity = vi.fn(async () => ({ ...snapshot }))
  const context = {
    app: { getPath: () => home, getPreferredSystemLanguages: () => ['en'] },
    powerSaveBlocker: blocker,
    powerMonitor: { getSystemIdleTime: () => Math.floor(Date.now() / 1000) },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    Notification: class extends EventEmitter {
      constructor() { super() }
      static isSupported() { return true }
      show() {}
    },
    readLocalePreference: () => 'en', resolveSupportedLocale: () => 'en',
    readIdlePowerActivity: readActivity, resolveMainRendererServerAccess: () => null,
    areStorageWritesFrozen: () => false, dataMigration: null,
    ELECTRON_EVENT_CHANNELS, mainWindow: window as Window | null,
    isQuitting: false, idlePowerRendererGeneration: 0,
    idlePowerInitialization: null, idlePowerService: null as IdlePowerService | null,
    createIdlePowerHost: async (options: Parameters<typeof createIdlePowerHost>[0]) => {
      const service = await createIdlePowerHost({ ...options, executeAction,
        detectCapabilities: () => pendingCapabilities ?? Promise.resolve({ lock: true, sleep: true, hibernate: false, shutdown: true }),
      })
      services.push(service)
      return service
    },
  }
  // Execute the real main-process callback and initialization checks, using the
  // real host/service. Only OS, persistence path and activity transport are fixtures.
  const getService = runInNewContext(`${transpile(source.slice(start, end), { target: ScriptTarget.ES2022 })}\ngetIdlePowerService`, context) as () => Promise<IdlePowerService>
  const attach = (target: Window) => {
    context.mainWindow = target
    installIdlePowerLifecycle(target.webContents as unknown as WebContents,
      () => context.idlePowerService, () => { context.idlePowerRendererGeneration += 1 })
  }
  attach(window)
  return { window, context, getService, attach, blocker, executeAction, readActivity,
    complete: () => { snapshot = { ...snapshot, revision: snapshot.revision + 2, completionSequence: snapshot.completionSequence + 1 } },
  }
}

describe('idle power main-process renderer lifecycle', () => {
  it('does not send from stop to destroyed WebContents while its window is still alive', async () => {
    const f = fixture()
    const service = await f.getService()
    service.configure({ action: 'sleep', scope: 'any', countdownSeconds: 30 })
    await advanceTime(0)
    f.complete()
    await advanceTime(1000)
    expect(f.blocker.start).toHaveBeenCalledOnce()
    f.window.webContents.send.mockClear()
    expect(f.window.isDestroyed()).toBe(false)
    expect(() => f.window.webContents.destroy()).not.toThrow()
    expect(f.window.webContents.send).not.toHaveBeenCalled()
    expect(f.blocker.stop).toHaveBeenCalledOnce()
    const reads = f.readActivity.mock.calls.length
    await advanceTime(60_000)
    expect(f.readActivity).toHaveBeenCalledTimes(reads)
    expect(f.executeAction).not.toHaveBeenCalled()
    expect(() => service.stop()).not.toThrow()
    const replacement = new Window()
    f.attach(replacement)
    expect(await f.getService()).toBe(service)
    service.configure({ action: 'sleep', scope: 'any', countdownSeconds: 30 })
    expect(replacement.webContents.send).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.powerIdleActionState,
      expect.objectContaining({ settings: { action: 'sleep', scope: 'any', countdownSeconds: 30 } }))
    expect(f.window.webContents.send).not.toHaveBeenCalled()
  })

  it.each(['quitting', 'window-destroyed', 'no-window'] as const)('disconnects state delivery when %s', async state => {
    const f = fixture()
    const service = await f.getService()
    if (state === 'quitting') f.context.isQuitting = true
    if (state === 'window-destroyed') f.window.destroyed = true
    if (state === 'no-window') f.context.mainWindow = null
    expect(() => service.dispose()).not.toThrow()
    expect(f.window.webContents.send).not.toHaveBeenCalled()
  })

  it.each(['did-navigate', 'render-process-gone'] as const)('preserves live state notifications and resumes after %s', async event => {
    const f = fixture()
    const service = await f.getService()
    service.configure({ action: 'sleep', scope: 'any', countdownSeconds: 30 })
    expect(f.window.webContents.send).toHaveBeenLastCalledWith(ELECTRON_EVENT_CHANNELS.powerIdleActionState,
      expect.objectContaining({ settings: { action: 'sleep', scope: 'any', countdownSeconds: 30 } }))
    await advanceTime(0)
    f.complete()
    await advanceTime(1000)
    f.window.webContents.emit(event)
    expect(f.blocker.stop).toHaveBeenCalledOnce()
    expect(f.window.webContents.send).toHaveBeenLastCalledWith(ELECTRON_EVENT_CHANNELS.powerIdleActionState,
      expect.objectContaining({ countdown: null }))
    expect(await f.getService()).toBe(service)
    await advanceTime(0)
    f.complete()
    await advanceTime(6000)
    expect(service.getState().countdown?.action).toBe('sleep')
    expect(f.window.webContents.send).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.powerIdleActionState,
      expect.objectContaining({ countdown: expect.objectContaining({ action: 'sleep' }) }))
    service.stop() // System suspend still synchronizes the live renderer.
    expect(f.window.webContents.send).toHaveBeenLastCalledWith(ELECTRON_EVENT_CHANNELS.powerIdleActionState,
      expect.objectContaining({ countdown: null }))
  })

  it.each(['destroyed', 'quitting'] as const)('rejects pending initialization after %s without sending to the lost renderer', async event => {
    let resolveCapabilities!: (value: { lock: boolean, sleep: boolean, hibernate: boolean, shutdown: boolean }) => void
    const capabilities = new Promise<Parameters<typeof resolveCapabilities>[0]>(resolve => { resolveCapabilities = resolve })
    const f = fixture(capabilities)
    const pending = f.getService()
    if (event === 'destroyed') f.window.webContents.destroy()
    else f.context.isQuitting = true
    resolveCapabilities({ lock: true, sleep: true, hibernate: false, shutdown: true })
    await expect(pending).rejects.toThrow(event === 'destroyed' ? 'Desktop window changed' : 'Application is quitting')
    expect(f.window.webContents.send).not.toHaveBeenCalled()
    await advanceTime(60_000)
    expect(f.executeAction).not.toHaveBeenCalled()
    if (event === 'destroyed') {
      const replacement = new Window()
      f.attach(replacement)
      const service = await f.getService()
      service.configure({ action: 'sleep', scope: 'any', countdownSeconds: 30 })
      expect(replacement.webContents.send).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.powerIdleActionState,
        expect.objectContaining({ settings: { action: 'sleep', scope: 'any', countdownSeconds: 30 } }))
    }
  })
})
