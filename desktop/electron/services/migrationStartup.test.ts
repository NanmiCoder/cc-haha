import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Run the actual startup registration with isolated host/runtime dependencies.
// No Electron process, user configuration, providers or credentials are loaded.
function startupFixture(
  failure?: 'recover' | 'validate' | 'rollback' | 'shutdown',
  options: { restore?: Promise<void>, createWindow?: Promise<void>, tray?: boolean } = {},
) {
  const desktopDir = path.basename(process.cwd()) === 'desktop' ? process.cwd() : path.join(process.cwd(), 'desktop')
  const source = readFileSync(path.join(desktopDir, 'electron/main.ts'), 'utf8')
  const start = source.indexOf('app.whenReady().then(async () => {')
  const end = source.indexOf("app.on('window-all-closed'", start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const calls: string[] = []
  const step = (name: string) => { calls.push(name) }
  const env: NodeJS.ProcessEnv = {}
  const migration = {
    async recover() { step('recover'); if (failure === 'recover') throw new Error('Missing target disk'); return 'validate' },
    async completeValidation() { step('complete') },
    async failValidation() { step('rollback'); if (failure === 'rollback') throw new Error('Original directory is unavailable') },
  }
  const runtime = {
    async startServer() { step('start'); expect(env.CC_HAHA_MIGRATION_VALIDATION === '1' || calls.includes('rollback')).toBe(true) },
    async validateMigrationStartup() { step('validate'); if (failure && failure !== 'recover') throw new Error('Invalid copied configuration') },
    async activateAfterMigrationValidation() { step('activate'); expect(calls).toContain('complete') },
    async stopAllAndWait() { step('stop'); if (failure === 'shutdown') throw new Error('Runtime process did not exit') },
  }
  const context = {
    app: { whenReady: () => Promise.resolve(), on: vi.fn() },
    process: { env, platform: 'win32' },
    applyWindowsAppUserModelId: () => {}, clearAppManagedPortableEnv: () => step('clearEnv'),
    applyStartupPortableMode: () => step('applyRoot'), getDataMigration: () => migration,
    setStorageWritesFrozen: vi.fn(), dialog: { showErrorBox: vi.fn() },
    createMainWindow: vi.fn(async () => { step('window'); await options.createWindow }), installSystemAppearanceWatch: () => {},
    screen: { on: vi.fn() }, mainWindow: null, workspaceBrowserService: null,
    getServerRuntime: () => runtime, serverRuntime: runtime as typeof runtime | null,
    getPublicAccessManager: vi.fn(() => ({ restore: async () => { step('publicAccess'); await options.restore } })),
    installApplicationMenu: vi.fn(async () => {}), shouldInstallTray: () => options.tray ?? false,
    installTray: vi.fn(async () => ({ dispose: vi.fn() })), trayController: null,
    appRoot: () => '/fixture/desktop', showMainWindow: vi.fn(), isQuitting: false,
    scheduleNotificationSmoke: vi.fn(), Notification: {}, emitNotificationAction: () => {},
    console: { error: vi.fn() },
  }
  const startup = runInNewContext(source.slice(start, end), context) as Promise<void>
  return { calls, context, env, startup }
}

describe('migration startup admission boundary', () => {
  it('persists validation before admitting tasks or restoring public access', async () => {
    const f = startupFixture()
    await f.startup
    expect(f.calls).toEqual(['clearEnv', 'recover', 'applyRoot', 'start', 'validate', 'complete', 'activate', 'window', 'publicAccess'])
    expect(f.env.CC_HAHA_MIGRATION_VALIDATION).toBeUndefined()
    expect(f.context.setStorageWritesFrozen).not.toHaveBeenCalled()
  })

  it('stops the validating runtime before rolling back and restarting the old root', async () => {
    const f = startupFixture('validate')
    await f.startup
    expect(f.calls).toEqual(['clearEnv', 'recover', 'applyRoot', 'start', 'validate', 'stop', 'rollback', 'clearEnv', 'applyRoot', 'start', 'window', 'publicAccess'])
    expect(f.calls).not.toContain('activate')
    expect(f.env.CC_HAHA_MIGRATION_VALIDATION).toBeUndefined()
  })

  it.each(['recover', 'rollback', 'shutdown'] as const)('fails closed when %s cannot complete safely', async failure => {
    const f = startupFixture(failure)
    await f.startup
    expect(f.context.setStorageWritesFrozen).toHaveBeenCalledWith(true)
    expect(f.context.dialog.showErrorBox).toHaveBeenCalledOnce()
    expect(f.calls.filter(call => call === 'start')).toHaveLength(failure === 'recover' ? 0 : 1)
    expect(f.calls).not.toContain('activate')
    expect(f.calls).not.toContain('publicAccess')
    expect(f.calls.at(-1)).toBe('window')
  })
})

describe('public access restore during startup', () => {
  it('makes the local window, menu and tray available while remote restore is pending', async () => {
    let resolveRestore!: () => void
    const restore = new Promise<void>(resolve => { resolveRestore = resolve })
    const f = startupFixture(undefined, { restore, tray: true })
    let startupFinished = false
    void f.startup.then(() => { startupFinished = true })
    try {
      // Yield one event-loop turn so the real startup's awaited local work runs.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(f.context.installApplicationMenu).toHaveBeenCalledOnce()
      expect(f.context.installTray).toHaveBeenCalledOnce()
      expect(f.context.createMainWindow).toHaveBeenCalledOnce()
      expect(f.context.scheduleNotificationSmoke).toHaveBeenCalledOnce()
      const activate = f.context.app.on.mock.calls.find(([event]) => event === 'activate')
      expect(typeof activate?.[1]).toBe('function')
      expect(f.calls).toContain('publicAccess')
      expect(startupFinished).toBe(true)
    } finally {
      resolveRestore()
      await f.startup
    }
  })

  it('handles a background restore failure after local startup completes', async () => {
    let rejectRestore!: (error: Error) => void
    const restore = new Promise<void>((_resolve, reject) => { rejectRestore = reject })
    const f = startupFixture(undefined, { restore })
    await f.startup
    rejectRestore(new Error('Tunnel verification unavailable'))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(f.context.createMainWindow).toHaveBeenCalledOnce()
    const activate = f.context.app.on.mock.calls.find(([event]) => event === 'activate')
    expect(typeof activate?.[1]).toBe('function')
  })

  it('does not begin remote restore when quitting during window creation', async () => {
    let resolveWindow!: () => void
    const createWindow = new Promise<void>(resolve => { resolveWindow = resolve })
    const f = startupFixture(undefined, { createWindow })
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(f.context.createMainWindow).toHaveBeenCalledOnce()
      f.context.isQuitting = true
    } finally {
      resolveWindow()
      await f.startup
    }
    expect(f.context.getPublicAccessManager).not.toHaveBeenCalled()
  })
})
