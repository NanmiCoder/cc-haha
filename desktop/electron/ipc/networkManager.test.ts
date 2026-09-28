import { describe, expect, it, vi } from 'vitest'
import { createNetworkManagerHandler } from './networkManager'
import { createDefaultNetworkProfiles, type NetworkManagerApi } from '../../src/features/network-manager/networkTypes'
import { ELECTRON_IPC_CHANNELS } from './channels'
import { isElectronIpcChannelAllowedForPetWindow, validateElectronIpcPayload } from './capabilities'

describe('network manager IPC authorization and routing', () => {
  function fixture() {
    const service = Object.fromEntries(['discoverProxy', 'executionCatalog', 'openNetworkConnections', 'list', 'save', 'inspect', 'plan', 'apply', 'recover', 'verify', 'probeHost', 'login', 'vpnRouteOptions', 'vpnRoutePreview', 'vpnRouteApply', 'vpnRouteVerify', 'vpnRouteBatchPreview', 'vpnRouteBatchApply', 'vpnRouteBatchVerify', 'vpnRouteProbe'].map(key => [key, vi.fn().mockResolvedValue({ ok: true, data: null })])) as unknown as NetworkManagerApi
    const sender = { mainFrame: {} }
    const getService = vi.fn(() => service)
    return { service, sender, getService, handler: createNetworkManagerHandler({ getMainWebContents: () => sender, getService }) }
  }
  it('rejects auxiliary windows and child frames before reading config or running a probe', async () => {
    const { sender, handler, getService } = fixture()
    await expect(handler({ sender: { mainFrame: sender.mainFrame }, senderFrame: sender.mainFrame }, { action: 'list' })).rejects.toThrow('main desktop window')
    await expect(handler({ sender, senderFrame: {} }, { action: 'list' })).rejects.toThrow('main desktop window')
    expect(getService).not.toHaveBeenCalled()
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.networkManager)).toBe(false)
  })
  it('passes only typed requests and never executes renderer-supplied changes or commands', async () => {
    const { sender, handler, service } = fixture()
    const event = { sender, senderFrame: sender.mainFrame }
    const profile = createDefaultNetworkProfiles()[0]
    await handler(event, { action: 'plan', profile })
    expect(service.plan).toHaveBeenCalledWith(profile)
    await handler(event, { action: 'apply', planId: 'native-plan' })
    expect(service.apply).toHaveBeenCalledWith('native-plan')
    const result = await handler(event, { action: 'apply', planId: 'native-plan', command: 'Remove-NetRoute' })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(service.apply).toHaveBeenCalledTimes(1)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.networkManager, { action: 'recover' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.networkManager, { action: 'login', target: 'vpn', profile, password: 'secret' })).toBe(false)
    await handler(event, { action: 'recover' })
    expect(service.recover).toHaveBeenCalledOnce()
  })
  it('exposes only typed read-only discovery/reference requests, never a script execution endpoint', async () => {
    const { sender, handler, service } = fixture()
    const event = { sender, senderFrame: sender.mainFrame }
    await handler(event, { action: 'discoverProxy', proxyPort: 7897 })
    expect(service.discoverProxy).toHaveBeenCalledWith(7897)
    await handler(event, { action: 'executionCatalog' })
    expect(service.executionCatalog).toHaveBeenCalledOnce()
    expect(await handler(event, { action: 'executionCatalog', script: 'Remove-NetRoute' })).toMatchObject({ ok: false })
    expect(await handler(event, { action: 'discoverProxy', proxyPort: 0 })).toMatchObject({ ok: false })
    expect(service.discoverProxy).toHaveBeenCalledTimes(1)
  })

  it('opens only the fixed applet from the main frame and rejects path/command injection', async () => {
    const { sender, handler, service, getService } = fixture()
    const request = { action: 'openNetworkConnections' }
    await expect(handler({ sender, senderFrame: {} }, request)).rejects.toThrow('main desktop window')
    expect(getService).not.toHaveBeenCalled()
    const event = { sender, senderFrame: sender.mainFrame }
    await handler(event, request)
    expect(service.openNetworkConnections).toHaveBeenCalledExactlyOnceWith()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.networkManager, request)).toBe(true)
    for (const extras of [{ command: 'cmd.exe' }, { path: 'C:\\untrusted.cpl' }, { args: ['arbitrary'] }, { profile: createDefaultNetworkProfiles()[0] }]) {
      expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.networkManager, { ...request, ...extras })).toBe(false)
      expect(await handler(event, { ...request, ...extras })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(service.openNetworkConnections).toHaveBeenCalledTimes(1)
  })

  it('passes route targets to domain validation while rejecting renderer commands', async () => {
    const { sender, handler, service } = fixture()
    const event = { sender, senderFrame: sender.mainFrame }
    const target = { destination: '10.204.19.81', vpnName: 'Office VPN', vpnScope: 'allUsers' }
    await handler(event, { action: 'vpnRoutePreview', target })
    expect(service.vpnRoutePreview).toHaveBeenCalledWith(target)
    const injected = await handler(event, { action: 'vpnRoutePreview', target: { ...target, command: 'Remove-NetRoute' } })
    expect(injected).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await handler(event, { action: 'vpnRoutePreview', target: { ...target, destination: '10.0.0.199' } })
    await handler(event, { action: 'vpnRoutePreview', target: { ...target, destination: '0.0.0.0/0' } })
    expect(service.vpnRoutePreview).toHaveBeenCalledTimes(3)
    expect(service.vpnRoutePreview).toHaveBeenLastCalledWith({ ...target, destination: '0.0.0.0/0' })
    const batch = { destinations: ['10.0.0.199', '10.55.1.0/24'], vpnName: target.vpnName, vpnScope: target.vpnScope }
    await handler(event, { action: 'vpnRouteBatchPreview', input: batch })
    expect(service.vpnRouteBatchPreview).toHaveBeenCalledWith(batch)
    await handler(event, { action: 'vpnRouteBatchApply', planId: 'reviewed-plan' })
    expect(service.vpnRouteBatchApply).toHaveBeenCalledWith('reviewed-plan')
    const probe = { address: '10.0.0.199', port: 80, protocol: 'http', vpnName: target.vpnName, vpnScope: target.vpnScope }
    await handler(event, { action: 'vpnRouteProbe', input: probe })
    expect(service.vpnRouteProbe).toHaveBeenCalledWith(probe)
    expect(await handler(event, { action: 'vpnRouteBatchPreview', input: { ...batch, commands: ['Remove-NetRoute'] } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await handler(event, { action: 'vpnRouteProbe', input: { ...probe, port: -1 } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })
})
