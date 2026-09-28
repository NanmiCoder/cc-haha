import { contextBridge, ipcRenderer } from 'electron'
import { validateElectronIpcPayload } from '../../../electron/ipc/capabilities'
import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from '../../../electron/ipc/channels'

contextBridge.exposeInMainWorld('networkFixtureBridge', {
  invoke(channel: ElectronIpcChannel, payload?: unknown) {
    if ((channel !== ELECTRON_IPC_CHANNELS.networkManager && channel !== ELECTRON_IPC_CHANNELS.mrListHosts) || !validateElectronIpcPayload(channel, payload)) throw new Error('Invalid network fixture request')
    return ipcRenderer.invoke(channel, payload)
  },
  async subscribe() { return () => undefined },
})
