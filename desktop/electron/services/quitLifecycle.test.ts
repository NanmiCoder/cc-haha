import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Execute the production registration without booting Electron or user sidecars.
// Dependencies are fixtures; the before-quit handler and its state are real.
function quitFixture(failingStep?: string, rejectServer = false, rejectPublicAccess = false) {
  const desktopDir = path.basename(process.cwd()) === 'desktop'
    ? process.cwd()
    : path.join(process.cwd(), 'desktop')
  const source = readFileSync(path.join(desktopDir, 'electron/main.ts'), 'utf8')
  const start = source.lastIndexOf("app.on('before-quit',")
  expect(start).toBeGreaterThan(0)
  const app = new EventEmitter() as EventEmitter & { quit: () => void }
  const calls: string[] = []
  const error = new Error('Object has been destroyed')
  const cleanup = (name: string) => () => {
    calls.push(name)
    if (failingStep === name) throw error
  }
  let finishServer!: () => void
  const serverDone = new Promise<void>((resolve, reject) => {
    finishServer = () => rejectServer ? reject(error) : resolve()
  })
  const exit = vi.fn()
  const requestQuit = () => {
    const event = { preventDefault: vi.fn() }
    app.emit('before-quit', event)
    if (!event.preventDefault.mock.calls.length) exit()
    return event
  }
  app.quit = vi.fn(requestQuit)
  const context = {
    app, isQuitting: false, quitCleanupStarted: false, quitCleanupFinished: false,
    mainWindow: {}, saveWindowState: cleanup('window'),
    trayController: { dispose: cleanup('tray') },
    terminalService: { killAll: cleanup('terminal') },
    previewService: { close: cleanup('preview') },
    petWindowController: { dispose: cleanup('pet') },
    workspaceBrowserService: null,
    publicAccessManager: {
      dispose: () => {
        cleanup('publicAccess')()
        return rejectPublicAccess ? Promise.reject(error) : Promise.resolve()
      },
    },
    getServerRuntime: () => {
      cleanup('server')()
      return { stopAllAndWait: () => serverDone }
    },
    console: { error: vi.fn() },
  }
  runInNewContext(source.slice(start), context)
  expect(app.listenerCount('before-quit')).toBe(1)
  return { context, requestQuit, app, exit, calls, finishServer, error }
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve))

describe('Electron quit lifecycle', () => {
  it('waits for server cleanup, coalesces repeated quits, then allows the final quit', async () => {
    const fixture = quitFixture()
    expect(fixture.requestQuit().preventDefault).toHaveBeenCalledOnce()
    expect(fixture.context.isQuitting).toBe(true)
    expect(fixture.requestQuit().preventDefault).toHaveBeenCalledOnce()
    expect(fixture.exit).not.toHaveBeenCalled()
    await settle()
    expect(fixture.calls).toEqual(['window', 'tray', 'terminal', 'preview', 'pet', 'publicAccess', 'server'])

    fixture.finishServer()
    await settle()
    expect(fixture.app.quit).toHaveBeenCalledOnce()
    expect(fixture.exit).toHaveBeenCalledOnce()
  })

  it.each(['window', 'tray', 'terminal', 'preview', 'pet', 'publicAccess'])(
    'still stops the server and quits when %s cleanup throws', async step => {
      const fixture = quitFixture(step)
      expect(() => fixture.requestQuit()).not.toThrow()
      fixture.requestQuit()
      await settle()
      expect(fixture.calls).toEqual(['window', 'tray', 'terminal', 'preview', 'pet', 'publicAccess', 'server'])
      expect(fixture.exit).not.toHaveBeenCalled()

      fixture.finishServer()
      await settle()
      expect(fixture.context.console.error).toHaveBeenCalled()
      expect(fixture.app.quit).toHaveBeenCalledOnce()
      expect(fixture.exit).toHaveBeenCalledOnce()
    },
  )

  it('still waits for the server if ngrok cleanup rejects asynchronously', async () => {
    const fixture = quitFixture(undefined, false, true)
    fixture.requestQuit()
    await settle()
    expect(fixture.calls).toContain('server')
    expect(fixture.exit).not.toHaveBeenCalled()
    expect(fixture.context.console.error).toHaveBeenCalledWith('[desktop] public access cleanup failed during quit')
    fixture.finishServer()
    await settle()
    expect(fixture.exit).toHaveBeenCalledOnce()
  })

  it('quits if obtaining the server runtime throws synchronously', async () => {
    const fixture = quitFixture('server')
    expect(() => fixture.requestQuit()).not.toThrow()
    await settle()
    expect(fixture.exit).toHaveBeenCalledOnce()
  })

  it('quits if graceful server shutdown rejects', async () => {
    const fixture = quitFixture(undefined, true)
    fixture.requestQuit()
    await settle()
    fixture.finishServer()
    await settle()
    expect(fixture.context.console.error).toHaveBeenCalled()
    expect(fixture.app.quit).toHaveBeenCalledOnce()
    expect(fixture.exit).toHaveBeenCalledOnce()
  })
})
