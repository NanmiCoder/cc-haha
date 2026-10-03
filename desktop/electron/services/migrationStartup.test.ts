import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Run the actual startup registration with isolated host/runtime dependencies.
// No Electron process, user configuration, providers or credentials are loaded.
async function startupFixture(failure?: 'recover' | 'validate' | 'rollback' | 'shutdown') {
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
    createMainWindow: async () => step('window'), installSystemAppearanceWatch: () => {},
    screen: { on: vi.fn() }, mainWindow: null, workspaceBrowserService: null,
    getServerRuntime: () => runtime, serverRuntime: runtime as typeof runtime | null,
    getPublicAccessManager: () => ({ restore: async () => step('publicAccess') }),
    installApplicationMenu: async () => {}, shouldInstallTray: () => false,
    scheduleNotificationSmoke: () => {}, Notification: {}, emitNotificationAction: () => {},
    console: { error: vi.fn() },
  }
  await runInNewContext(source.slice(start, end), context)
  return { calls, context, env }
}

describe('migration startup admission boundary', () => {
  it('persists validation before admitting tasks or restoring public access', async () => {
    const f = await startupFixture()
    expect(f.calls).toEqual(['clearEnv', 'recover', 'applyRoot', 'start', 'validate', 'complete', 'activate', 'publicAccess', 'window'])
    expect(f.env.CC_HAHA_MIGRATION_VALIDATION).toBeUndefined()
    expect(f.context.setStorageWritesFrozen).not.toHaveBeenCalled()
  })

  it('stops the validating runtime before rolling back and restarting the old root', async () => {
    const f = await startupFixture('validate')
    expect(f.calls).toEqual(['clearEnv', 'recover', 'applyRoot', 'start', 'validate', 'stop', 'rollback', 'clearEnv', 'applyRoot', 'start', 'publicAccess', 'window'])
    expect(f.calls).not.toContain('activate')
    expect(f.env.CC_HAHA_MIGRATION_VALIDATION).toBeUndefined()
  })

  it.each(['recover', 'rollback', 'shutdown'] as const)('fails closed when %s cannot complete safely', async failure => {
    const f = await startupFixture(failure)
    expect(f.context.setStorageWritesFrozen).toHaveBeenCalledWith(true)
    expect(f.context.dialog.showErrorBox).toHaveBeenCalledOnce()
    expect(f.calls.filter(call => call === 'start')).toHaveLength(failure === 'recover' ? 0 : 1)
    expect(f.calls).not.toContain('activate')
    expect(f.calls).not.toContain('publicAccess')
    expect(f.calls.at(-1)).toBe('window')
  })
})
