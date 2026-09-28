import { describe, expect, it, vi } from 'vitest'
import { createElectronHost } from '../../lib/desktopHost/electronHost'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { ELECTRON_IPC_CHANNELS } from '../../../electron/ipc/channels'
import { createDefaultNetworkProfiles } from './networkTypes'

describe('network manager desktop bridge', () => {
  it('connects every operation to the validated native channel without browser access', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: null })
    const api = createElectronHost({ invoke, subscribe: vi.fn() }).networkManager!
    const profile = createDefaultNetworkProfiles()[0]
    await api.list()
    await api.save(profile, 4)
    await api.inspect(profile)
    await api.plan(profile)
    await api.apply('native-plan')
    await api.verify(profile)
    await api.probeHost('793bb617-022a-4dd1-85ca-e7e832dfc3fd')
    await api.login('vpn', profile)
    await api.recover()
    expect(invoke.mock.calls.map(call => call[1].action)).toEqual(['list', 'save', 'inspect', 'plan', 'apply', 'verify', 'probeHost', 'login', 'recover'])
    expect(invoke.mock.calls.every(call => call[0] === ELECTRON_IPC_CHANNELS.networkManager)).toBe(true)
    expect(browserHost.networkManager).toBeUndefined()
    await expect(api.save({ ...profile, containerPrefix: '10.0.0.0/8' }, 4)).rejects.toThrow('Invalid Electron IPC payload')
    expect(invoke).toHaveBeenCalledTimes(9)
    await api.discoverProxy(7897)
    await api.executionCatalog()
    expect(invoke).toHaveBeenNthCalledWith(10, ELECTRON_IPC_CHANNELS.networkManager, { action: 'discoverProxy', proxyPort: 7897 })
    expect(invoke).toHaveBeenNthCalledWith(11, ELECTRON_IPC_CHANNELS.networkManager, { action: 'executionCatalog' })
    await expect(api.discoverProxy(70000)).rejects.toThrow('Invalid Electron IPC payload')
    await api.openNetworkConnections()
    expect(invoke).toHaveBeenNthCalledWith(12, ELECTRON_IPC_CHANNELS.networkManager, { action: 'openNetworkConnections' })
  })
})
