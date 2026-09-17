import { contextBridge, ipcRenderer } from 'electron'
import { validateElectronIpcPayload } from '../../../electron/ipc/capabilities'
import { ELECTRON_EVENT_CHANNELS, type ElectronIpcChannel } from '../../../electron/ipc/channels'

contextBridge.exposeInMainWorld('contextFixtureBridge', {
  getWorkDir: () => ipcRenderer.invoke('context-fixture-work-dir'),
  invoke(channel: ElectronIpcChannel, payload?: unknown) {
    if (!validateElectronIpcPayload(channel, payload)) throw new Error('Invalid fixture IPC payload')
    return ipcRenderer.invoke(channel, payload)
  },
  async subscribe(channel: string, handler: (value: unknown) => void) {
    if (!Object.values(ELECTRON_EVENT_CHANNELS).includes(channel as never)) throw new Error('Unsupported fixture event')
    const listener = (_event: unknown, value: unknown) => handler(value)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})
