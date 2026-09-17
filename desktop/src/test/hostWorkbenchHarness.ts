import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { createManagedResourcesModule } from '../../electron/services/managedResources/index.js'
import type { DataBrowserAdapterFactory } from '../../electron/services/managedResources/dataBrowserService.js'
import type { DataConnectionDriverLoader } from '../../electron/services/managedResources/dataConnectionRuntime.js'
import { createElectronHost } from '../lib/desktopHost/electronHost.js'
import { useHostManagementStore } from '../features/managed-resources/stores/hostManagementStore.js'
import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from '../../electron/ipc/channels.js'

export async function createHostWorkbenchHarness(options: { vaultAvailable?: boolean; dataBrowserAdapters?: DataBrowserAdapterFactory; dataConnectionDrivers?: DataConnectionDriverLoader } = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-workbench-dom-'))
  const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>>()
  const mainFrame = {}
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>()
  const webContents = {
    id: 42, mainFrame, isDestroyed: () => false,
    send(channel: string, payload: unknown) {
      for (const listener of eventListeners.get(channel) ?? []) listener(payload)
    },
  }
  const mainWindow = { id: 99, webContents, isDestroyed: () => false } as unknown as BrowserWindow
  const calls: string[] = []
  let importPath: string | null = null
  let nextOpenGate: Promise<void> | undefined
  let openCount = 0
  let exportPath: string | null = path.join(tempDir, 'export.json')
  let nextGate: Promise<void> | undefined
  let gateChannel: ElectronIpcChannel = ELECTRON_IPC_CHANNELS.mrSaveHost
  const module = createManagedResourcesModule({
    activeConfigDir: tempDir, userDataDir: tempDir,
    dataBrowserAdapters: options.dataBrowserAdapters,
    dataConnectionDrivers: options.dataConnectionDrivers,
    getMainWindow: () => mainWindow,
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler) },
      removeHandler(channel) { handlers.delete(channel) },
    } as IpcMain,
    safeStorage: {
      isEncryptionAvailable: () => options.vaultAvailable !== false,
      encryptString: value => Buffer.from(`fixture-sealed:${value}`, 'utf8'),
      decryptString: value => {
        const text = value.toString('utf8')
        if (!text.startsWith('fixture-sealed:')) throw new Error('fixture decrypt failed')
        return text.slice('fixture-sealed:'.length)
      },
    },
    dialogService: {
      showOpenDialog: async () => {
        openCount += 1
        const gate = nextOpenGate
        nextOpenGate = undefined
        if (gate) await gate
        return { canceled: importPath === null, filePaths: importPath ? [importPath] : [] }
      },
      showSaveDialog: async () => ({ canceled: exportPath === null, ...(exportPath ? { filePath: exportPath } : {}) }),
    },
  })
  const host = createElectronHost({
    async invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T> {
      calls.push(channel)
      if (nextGate && channel === gateChannel) {
        const gate = nextGate
        nextGate = undefined
        await gate
      }
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No fixture handler: ${channel}`)
      return await handler({ sender: webContents, senderFrame: mainFrame } as IpcMainInvokeEvent, payload) as T
    },
    async subscribe<T>(channel: string, handler: (payload: T) => void) {
      const listeners = eventListeners.get(channel) ?? new Set<(payload: unknown) => void>()
      const listener = (payload: unknown) => handler(payload as T)
      listeners.add(listener)
      eventListeners.set(channel, listeners)
      return () => { listeners.delete(listener) }
    },
  })
  const previous = window.desktopHost
  window.desktopHost = host
  useHostManagementStore.setState(useHostManagementStore.getInitialState(), true)
  return {
    host, services: module.services, tempDir, calls,
    get openCount() { return openCount },
    holdNextOpen() {
      let release!: () => void
      nextOpenGate = new Promise<void>(resolve => { release = resolve })
      return release
    },
    setImportPath(value: string | null) { importPath = value },
    setExportPath(value: string | null) { exportPath = value },
    holdNextSave(channel: ElectronIpcChannel = ELECTRON_IPC_CHANNELS.mrSaveHost) {
      gateChannel = channel
      let release!: () => void
      nextGate = new Promise<void>(resolve => { release = resolve })
      return release
    },
    async document() {
      const loaded = await module.services.store.load()
      if (loaded.status !== 'ready') throw new Error('fixture resource document unavailable')
      return loaded.document
    },
    async dispose() {
      module.cleanup()
      eventListeners.clear()
      await module.services.sshService.dispose()
      await module.services.dataBrowserService?.dispose()
      window.desktopHost = previous
      useHostManagementStore.setState(useHostManagementStore.getInitialState(), true)
      await fs.rm(tempDir, { recursive: true, force: true })
    },
  }
}
