import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS,
  installRendererLifecycle,
  showRendererRecoveryFailure,
} from './rendererLifecycle'

class FakeWebContents extends EventEmitter {
  destroyed = false
  reload = vi.fn()

  isDestroyed() {
    return this.destroyed
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  webContents = new FakeWebContents()

  isDestroyed() {
    return this.destroyed
  }
}

function createHarness(options: { quitting?: boolean } = {}) {
  const window = new FakeWindow()
  let quitting = options.quitting ?? false
  const recordDiagnostic = vi.fn((detail: string) => `sanitized:${detail}`)
  const writeSnapshot = vi.fn()
  const onRendererProcessGone = vi.fn()
  const onRecoveryExhausted = vi.fn()

  installRendererLifecycle({
    window: window as never,
    isQuitting: () => quitting,
    recordDiagnostic,
    writeSnapshot,
    onRendererProcessGone,
    onRecoveryExhausted,
  })

  return {
    window,
    recordDiagnostic,
    writeSnapshot,
    onRendererProcessGone,
    onRecoveryExhausted,
    setQuitting(value: boolean) {
      quitting = value
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Electron renderer lifecycle recovery', () => {
  it('allows a later crash to recover after a full minute of healthy loaded operation', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const details = { reason: 'crashed', exitCode: -1073741819 }
    harness.window.webContents.emit('render-process-gone', {}, details)
    vi.advanceTimersByTime(1)
    harness.window.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(60_000)
    harness.window.webContents.emit('render-process-gone', {}, details)
    vi.advanceTimersByTime(1)
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(2)
    expect(harness.onRecoveryExhausted).not.toHaveBeenCalled()
  })

  it('does not renew the recovery budget for a load/crash loop and preserves the native exit', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const details = { reason: 'crashed', exitCode: -1073741819 }
    harness.window.webContents.emit('render-process-gone', {}, details)
    vi.advanceTimersByTime(1)
    harness.window.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(59_999)
    harness.window.webContents.emit('render-process-gone', {}, details)
    vi.advanceTimersByTime(60_000)
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(harness.onRecoveryExhausted.mock.calls[0]?.[0]).toContain('exitCode=-1073741819 (0xC0000005)')
  })

  it('reports a reload that never finishes with its original crash fingerprint', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1073741819 })
    vi.advanceTimersByTime(30_001)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(harness.onRecoveryExhausted.mock.calls[0]?.[0]).toContain('load-timeout')
    expect(harness.onRecoveryExhausted.mock.calls[0]?.[0]).toContain('exitCode=-1073741819 (0xC0000005)')
    vi.advanceTimersByTime(120_000)
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
  })

  it('requires a new uninterrupted stable interval after unresponsiveness', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const details = { reason: 'crashed', exitCode: 1 }
    harness.window.webContents.emit('render-process-gone', {}, details)
    vi.advanceTimersByTime(1)
    harness.window.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(59_000)
    harness.window.webContents.emit('unresponsive')
    vi.advanceTimersByTime(2_000)
    harness.window.webContents.emit('responsive')
    vi.advanceTimersByTime(59_000)
    harness.window.webContents.emit('render-process-gone', {}, details)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(120_000)
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the stable interval across iframe loads and same-document navigation', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const details = { reason: 'crashed', exitCode: 1 }
    harness.window.webContents.emit('render-process-gone', {}, details)
    vi.advanceTimersByTime(1)
    harness.window.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(1_000)
    harness.window.webContents.emit('did-start-navigation', {}, 'about:srcdoc', false, false)
    harness.window.webContents.emit('did-start-loading')
    harness.window.webContents.emit('did-frame-finish-load', {}, false, 1, 2)
    harness.window.webContents.emit('did-stop-loading')
    harness.window.webContents.emit('did-start-navigation', {}, 'file:///app/index.html#chat', true, true)
    // A navigation guard can cancel this before the main frame commits.
    harness.window.webContents.emit('did-start-navigation', {}, 'https://example.com', false, true)
    vi.advanceTimersByTime(59_000)
    harness.window.webContents.emit('render-process-gone', {}, details)
    vi.advanceTimersByTime(1)
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(2)
    expect(harness.onRecoveryExhausted).not.toHaveBeenCalled()
  })

  it('waits for the new main-frame load before starting a fresh stable interval', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const details = { reason: 'crashed', exitCode: 1 }
    harness.window.webContents.emit('render-process-gone', {}, details)
    vi.advanceTimersByTime(1)
    harness.window.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(59_000)
    harness.window.webContents.emit('did-start-navigation', {}, 'file:///app/index.html', false, true)
    harness.window.webContents.emit('did-navigate', {}, 'file:///app/index.html', 200, 'OK')
    vi.advanceTimersByTime(2_000)
    harness.window.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(59_000)
    harness.window.webContents.emit('render-process-gone', {}, details)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale load before reload and a late successful load after exhaustion', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 3 })
    harness.window.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(30_001)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
    harness.window.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(60_000)
    harness.window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 })
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
  })

  it.each(['closed', 'destroyed', 'quitting'] as const)('suppresses pending load timeout and stability callbacks after %s', state => {
    vi.useFakeTimers()
    for (const loaded of [false, true]) {
      const harness = createHarness()
      harness.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
      vi.advanceTimersByTime(1)
      if (loaded) harness.window.webContents.emit('did-finish-load')
      if (state === 'closed') harness.window.emit('closed')
      if (state === 'destroyed') harness.window.webContents.destroyed = true
      if (state === 'quitting') harness.setQuitting(true)
      vi.advanceTimersByTime(120_000)
      expect(harness.onRecoveryExhausted).not.toHaveBeenCalled()
      expect(harness.recordDiagnostic).not.toHaveBeenCalledWith('[recovery-stable]')
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('reloads after the first renderer exit and reports repeated failure only once', () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const details = { reason: 'crashed', exitCode: 139 }

    harness.window.webContents.emit('render-process-gone', {}, details)

    expect(harness.window.webContents.reload).not.toHaveBeenCalled()
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      '[process-gone] reason=crashed exitCode=139 (0x0000008B)',
    )
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      '[recovery-started] trigger=process-gone:crashed',
    )
    expect(harness.writeSnapshot).toHaveBeenCalledWith('render-process-gone:crashed:139')
    expect(harness.onRendererProcessGone).toHaveBeenCalledWith(
      'sanitized:[process-gone] reason=crashed exitCode=139 (0x0000008B)',
    )

    harness.window.webContents.emit('render-process-gone', {}, details)
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      '[recovery-already-scheduled] trigger=process-gone:crashed',
    )
    expect(harness.onRecoveryExhausted).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    vi.runOnlyPendingTimers()
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)

    harness.window.webContents.emit('render-process-gone', {}, details)
    harness.window.webContents.emit('render-process-gone', {}, details)

    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(harness.onRecoveryExhausted).toHaveBeenCalledWith(
      'sanitized:[recovery-exhausted] trigger=process-gone:crashed reason=crashed exitCode=139 (0x0000008B)',
    )
  })

  it('reloads only after unresponsiveness persists for the full delay', () => {
    vi.useFakeTimers()
    const harness = createHarness()

    harness.window.webContents.emit('unresponsive')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS / 2)
    harness.window.webContents.emit('unresponsive')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS / 2 - 1)
    expect(harness.window.webContents.reload).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(harness.window.webContents.reload).not.toHaveBeenCalled()
    vi.runOnlyPendingTimers()
    expect(harness.window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(harness.recordDiagnostic).toHaveBeenCalledWith(
      '[recovery-started] trigger=unresponsive-timeout',
    )
  })

  it('cancels pending recovery when the renderer becomes responsive or the window closes', () => {
    vi.useFakeTimers()
    const harness = createHarness()

    harness.window.webContents.emit('unresponsive')
    harness.window.webContents.emit('responsive')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS)
    expect(harness.window.webContents.reload).not.toHaveBeenCalled()
    expect(harness.writeSnapshot).toHaveBeenCalledWith('responsive')

    harness.window.webContents.emit('unresponsive')
    harness.window.emit('closed')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS)
    expect(harness.window.webContents.reload).not.toHaveBeenCalled()
  })

  it('does not reload a destroyed window or web contents, or while the app is quitting', () => {
    vi.useFakeTimers()
    const destroyedWindowHarness = createHarness()
    destroyedWindowHarness.window.destroyed = true
    destroyedWindowHarness.window.webContents.emit('unresponsive')
    vi.advanceTimersByTime(DEFAULT_RENDERER_UNRESPONSIVE_RECOVERY_DELAY_MS)
    expect(destroyedWindowHarness.window.webContents.reload).not.toHaveBeenCalled()

    const destroyedContentsHarness = createHarness()
    destroyedContentsHarness.window.webContents.destroyed = true
    destroyedContentsHarness.window.webContents.emit('render-process-gone', {}, {
      reason: 'crashed',
      exitCode: 1,
    })
    expect(destroyedContentsHarness.window.webContents.reload).not.toHaveBeenCalled()

    const quittingHarness = createHarness({ quitting: true })
    quittingHarness.window.webContents.emit('render-process-gone', {}, {
      reason: 'clean-exit',
      exitCode: 0,
    })
    expect(quittingHarness.window.webContents.reload).not.toHaveBeenCalled()
    expect(quittingHarness.onRecoveryExhausted).not.toHaveBeenCalled()
  })

  it('rechecks destruction and quitting before a deferred reload and cancels it on close', () => {
    vi.useFakeTimers()
    const details = { reason: 'crashed', exitCode: 1 }

    const destroyedWindowHarness = createHarness()
    destroyedWindowHarness.window.webContents.emit('render-process-gone', {}, details)
    destroyedWindowHarness.window.destroyed = true
    vi.runOnlyPendingTimers()
    expect(destroyedWindowHarness.window.webContents.reload).not.toHaveBeenCalled()
    expect(destroyedWindowHarness.recordDiagnostic).toHaveBeenCalledWith(
      '[recovery-skipped] trigger=process-gone:crashed quitting=false',
    )

    const destroyedContentsHarness = createHarness()
    destroyedContentsHarness.window.webContents.emit('render-process-gone', {}, details)
    destroyedContentsHarness.window.webContents.destroyed = true
    vi.runOnlyPendingTimers()
    expect(destroyedContentsHarness.window.webContents.reload).not.toHaveBeenCalled()

    const quittingHarness = createHarness()
    quittingHarness.window.webContents.emit('render-process-gone', {}, details)
    quittingHarness.setQuitting(true)
    vi.runOnlyPendingTimers()
    expect(quittingHarness.window.webContents.reload).not.toHaveBeenCalled()

    const closedHarness = createHarness()
    closedHarness.window.webContents.emit('render-process-gone', {}, details)
    expect(vi.getTimerCount()).toBe(1)
    closedHarness.window.emit('closed')
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(closedHarness.window.webContents.reload).not.toHaveBeenCalled()
  })

  it('reports reload and recovered main-frame load failures once while ignoring aborts', () => {
    vi.useFakeTimers()
    const reloadErrorHarness = createHarness()
    reloadErrorHarness.window.webContents.reload.mockImplementation(() => {
      throw new Error('reload failed')
    })
    reloadErrorHarness.window.webContents.emit('render-process-gone', {}, {
      reason: 'crashed',
      exitCode: 1,
    })
    vi.runOnlyPendingTimers()
    expect(reloadErrorHarness.onRecoveryExhausted).toHaveBeenCalledWith(
      'sanitized:[recovery-exhausted] trigger=process-gone:crashed reloadError=reload failed reason=crashed exitCode=1 (0x00000001)',
    )

    const loadFailureHarness = createHarness()
    loadFailureHarness.window.webContents.emit('render-process-gone', {}, {
      reason: 'crashed',
      exitCode: 1,
    })
    vi.runOnlyPendingTimers()
    loadFailureHarness.window.webContents.emit(
      'did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///app/index.html', true,
    )
    expect(loadFailureHarness.onRecoveryExhausted).not.toHaveBeenCalled()

    loadFailureHarness.window.webContents.emit(
      'did-fail-load', {}, -2, 'ERR_FAILED', 'file:///app/index.html', false,
    )
    expect(loadFailureHarness.onRecoveryExhausted).not.toHaveBeenCalled()

    loadFailureHarness.window.webContents.emit(
      'did-fail-load', {}, -2, 'ERR_FAILED', 'file:///app/index.html', true,
    )
    loadFailureHarness.window.webContents.emit(
      'did-fail-load', {}, -2, 'ERR_FAILED', 'file:///app/index.html', true,
    )
    expect(loadFailureHarness.onRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(loadFailureHarness.onRecoveryExhausted.mock.calls[0]?.[0]).toContain('trigger=process-gone:crashed loadError=-2:ERR_FAILED reason=crashed exitCode=1')
  })
})

describe('renderer recovery failure dialog', () => {
  it.each([0, 1])('offers restart with diagnostics and honors response %s', async response => {
    const window = new FakeWindow()
    const showMessageBox = vi.fn().mockResolvedValue({ response })
    const app = { relaunch: vi.fn(), quit: vi.fn() }
    await showRendererRecoveryFailure({
      window: window as never, isQuitting: () => false,
      dialog: { showMessageBox } as never, app,
      detail: '[recovery-exhausted] reason=crashed exitCode=-1073741819 (0xC0000005)',
    })
    expect(showMessageBox).toHaveBeenCalledWith(window, expect.objectContaining({
      detail: expect.stringContaining('exitCode=-1073741819 (0xC0000005)'),
      buttons: ['重启应用 / Restart App', '稍后 / Later'], cancelId: 1,
    }))
    expect(app.relaunch).toHaveBeenCalledTimes(response === 0 ? 1 : 0)
    expect(app.quit).toHaveBeenCalledTimes(response === 0 ? 1 : 0)
    if (response === 0) expect(app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(app.quit.mock.invocationCallOrder[0]!)
  })

  it.each(['closed', 'quitting'] as const)('does not restart if %s before or during the dialog', async state => {
    for (const before of [false, true]) {
      const window = new FakeWindow()
      let quitting = false
      const invalidate = () => {
        if (state === 'closed') window.destroyed = true
        else quitting = true
      }
      if (before) invalidate()
      const showMessageBox = vi.fn(async () => {
        invalidate()
        return { response: 0 }
      })
      const app = { relaunch: vi.fn(), quit: vi.fn() }
      await showRendererRecoveryFailure({ window: window as never, isQuitting: () => quitting, dialog: { showMessageBox } as never, app, detail: 'crashed' })
      expect(showMessageBox).toHaveBeenCalledTimes(before ? 0 : 1)
      expect(app.relaunch).not.toHaveBeenCalled()
      expect(app.quit).not.toHaveBeenCalled()
    }
  })
})
