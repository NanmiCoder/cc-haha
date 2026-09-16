import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createManagedResourcesModule } from './index.js'

describe('createManagedResourcesModule', () => {
  it('instantiates all repositories and registers IPC cleanly', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-module-test-'))
    const handlers = new Map<string, any>()
    const fakeIpcMain: any = {
      handle(channel: string, handler: any) {
        handlers.set(channel, handler)
      },
      removeHandler(channel: string) {
        handlers.delete(channel)
      },
    }

    const fakeSafeStorage: any = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    }

    const fakeWindow: any = {
      id: 99,
      webContents: { id: 42, mainFrame: {} },
    }

    const mod = createManagedResourcesModule({
      getMainWindow: () => fakeWindow,
      userDataDir: tempDir,
      ipcMain: fakeIpcMain,
      safeStorage: fakeSafeStorage,
    })

    expect(mod.services.store).toBeDefined()
    expect(mod.services.libService).toBeDefined()
    expect(mod.services.vault).toBeDefined()
    expect(mod.services.credentialService).toBeDefined()
    expect(mod.services.selectionsRepo).toBeDefined()
    expect(mod.services.temporaryCredentials).toBeDefined()
    expect(handlers.size).toBeGreaterThan(10)

    mod.cleanup()
    expect(handlers.size).toBe(0)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('correctly binds storage to explicit activeConfigDir in portable mode', async () => {
    const portableDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-portable-test-'))
    const handlers = new Map<string, any>()
    const fakeIpcMain: any = {
      handle: (c: string, h: any) => handlers.set(c, h),
      removeHandler: (c: string) => handlers.delete(c),
    }
    const fakeSafeStorage: any = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    }
    const fakeWindow: any = { id: 1, webContents: { id: 10, mainFrame: {} } }

    const mod = createManagedResourcesModule({
      getMainWindow: () => fakeWindow,
      activeConfigDir: portableDir,
      ipcMain: fakeIpcMain,
      safeStorage: fakeSafeStorage,
    })

    expect(mod.services.store.filePath).toBe(path.join(portableDir, 'cc-haha', 'host-management', 'resources.json'))
    expect(mod.services.selectionsRepo.filePath).toBe(path.join(portableDir, 'cc-haha', 'host-management', 'context-selections.json'))

    mod.cleanup()
    await fs.rm(portableDir, { recursive: true, force: true })
  })

  it('correctly binds storage in default mode via activeConfigDir', async () => {
    const defaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-default-test-'))
    const handlers = new Map<string, any>()
    const fakeIpcMain: any = {
      handle: (c: string, h: any) => handlers.set(c, h),
      removeHandler: (c: string) => handlers.delete(c),
    }
    const fakeSafeStorage: any = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    }
    const fakeWindow: any = { id: 1, webContents: { id: 10, mainFrame: {} } }

    const mod = createManagedResourcesModule({
      getMainWindow: () => fakeWindow,
      activeConfigDir: defaultDir,
      ipcMain: fakeIpcMain,
      safeStorage: fakeSafeStorage,
    })

    expect(mod.services.store.filePath).toBe(path.join(defaultDir, 'cc-haha', 'host-management', 'resources.json'))
    expect(mod.services.selectionsRepo.filePath).toBe(path.join(defaultDir, 'cc-haha', 'host-management', 'context-selections.json'))

    mod.cleanup()
    await fs.rm(defaultDir, { recursive: true, force: true })
  })
})
