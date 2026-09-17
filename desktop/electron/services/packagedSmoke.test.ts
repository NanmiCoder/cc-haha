import { describe, expect, it, vi } from 'vitest'
import { installPackagedSmokeQuitWatcher } from './packagedSmoke'

describe('packaged Electron smoke quit watcher', () => {
  it('does nothing unless the smoke sentinel is configured', () => {
    const quit = vi.fn()
    const setIntervalFn = vi.fn()
    expect(installPackagedSmokeQuitWatcher({ quit } as never, {}, { setIntervalFn: setIntervalFn as never })).toBeTypeOf('function')
    expect(setIntervalFn).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('quits exactly once after the configured sentinel appears', () => {
    const quit = vi.fn()
    const clearIntervalFn = vi.fn()
    let callback: () => void = () => { throw new Error('smoke timer was not installed') }
    const timer = { unref: vi.fn() }
    const setIntervalFn = vi.fn((next: () => void) => {
      callback = next
      return timer
    })
    let exists = false
    installPackagedSmokeQuitWatcher(
      { quit } as never,
      { CC_HAHA_ELECTRON_PACKAGED_SMOKE_QUIT_FILE: 'C:\\temp\\quit.signal' },
      {
        existsSyncFn: () => exists,
        setIntervalFn: setIntervalFn as never,
        clearIntervalFn: clearIntervalFn as never,
      },
    )

    expect(timer.unref).toHaveBeenCalledTimes(1)
    callback()
    expect(quit).not.toHaveBeenCalled()
    exists = true
    callback()
    callback()
    expect(clearIntervalFn).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
