import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('app mode restart lifecycle', () => {
  it('synchronously stops Windows sidecars before relaunching with another data directory', () => {
    const desktopDir = path.basename(process.cwd()) === 'desktop'
      ? process.cwd()
      : path.join(process.cwd(), 'desktop')
    const source = readFileSync(path.join(desktopDir, 'electron', 'main.ts'), 'utf8')
    const handler = source.match(
      /registerHandler\(ELECTRON_IPC_CHANNELS\.appModePrepareRestart,[\s\S]*?\n\s*registerHandler/,
    )?.[0]

    expect(handler).toContain('getServerRuntime().stopAll(true)')
  })


  it('keeps the Electron host alive until graceful server shutdown finishes', () => {
    const desktopDir = path.basename(process.cwd()) === 'desktop'
      ? process.cwd()
      : path.join(process.cwd(), 'desktop')
    const source = readFileSync(path.join(desktopDir, 'electron', 'main.ts'), 'utf8')
    const handler = source.match(/app\.on\('before-quit',[\s\S]*\n\}\)\s*$/)?.[0]

    expect(handler).toContain('event.preventDefault()')
    expect(handler).toContain('getServerRuntime().stopAllAndWait()')
    expect(handler).toMatch(/stopAllAndWait\(\)[\s\S]*app\.quit\(\)/)
  })
})

// Runs the production updatePrepareInstall handler from main.ts against
// fixtures, without booting Electron or a sidecar.
function prepareInstallFixture() {
  const desktopDir = path.basename(process.cwd()) === 'desktop'
    ? process.cwd()
    : path.join(process.cwd(), 'desktop')
  const source = readFileSync(path.join(desktopDir, 'electron', 'main.ts'), 'utf8')
  const start = source.indexOf('registerHandler(ELECTRON_IPC_CHANNELS.updatePrepareInstall,')
  const end = source.indexOf('registerHandler(ELECTRON_IPC_CHANNELS.updateCancelInstall,', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)

  const calls: string[] = []
  let finishRuntime!: (error?: Error) => void
  const runtimeExited = new Promise<void>((resolve, reject) => {
    finishRuntime = error => error ? reject(error) : resolve()
  })
  let handler: (() => Promise<void>) | null = null
  runInNewContext(source.slice(start, end), {
    ELECTRON_IPC_CHANNELS: { updatePrepareInstall: 'update-prepare-install' },
    registerHandler: (_channel: string, fn: () => Promise<void>) => { handler = fn },
    publicAccessManager: { stop: async () => { calls.push('publicAccess') } },
    getServerRuntime: () => ({
      stopAllAndWait: () => {
        calls.push('runtime')
        return runtimeExited
      },
      stopAll: () => { calls.push('stopAll') },
    }),
    Error,
    String,
  })
  if (!handler) throw new Error('updatePrepareInstall handler was not registered')
  return { run: handler as () => Promise<void>, calls, finishRuntime }
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve))

describe('update install preparation', () => {
  it('resolves only after the runtime and its children have exited', async () => {
    const fixture = prepareInstallFixture()
    let resolved = false
    const pending = fixture.run().then(() => { resolved = true })

    await settle()
    expect(fixture.calls).toEqual(['publicAccess', 'runtime'])
    expect(resolved).toBe(false)

    fixture.finishRuntime()
    await pending
    expect(resolved).toBe(true)
  })

  it('fails the install when the runtime does not exit, so the renderer can retry', async () => {
    const fixture = prepareInstallFixture()
    const pending = fixture.run()
    await settle()
    fixture.finishRuntime(new Error('Runtime processes did not exit'))

    await expect(pending).rejects.toThrow(/still shutting down[\s\S]*Runtime processes did not exit/)
  })
})
