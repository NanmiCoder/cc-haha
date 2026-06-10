import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '../lib/desktopHost/browserHost'

describe('adapterStore IM pairing behavior', () => {
  const adaptersApi = {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    startWechatLogin: vi.fn(),
    pollWechatLogin: vi.fn(),
    startWhatsAppLogin: vi.fn(),
    pollWhatsAppLogin: vi.fn(),
    unbindWechat: vi.fn(),
    unbindDingtalk: vi.fn(),
    unbindWhatsApp: vi.fn(),
    beginDingtalkRegistration: vi.fn(),
    pollDingtalkRegistration: vi.fn(),
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    adaptersApi.updateConfig.mockImplementation(async (patch) => patch)
    vi.doMock('../api/adapters', () => ({ adaptersApi }))
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
    Reflect.deleteProperty(window, 'desktopHost')
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    Reflect.deleteProperty(window, '__TAURI__')
  })

  it('restarts adapter sidecar through an injected desktop host after config changes', async () => {
    const restartSidecar = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
      },
      adapters: {
        restartSidecar,
      },
    }

    const { useAdapterStore } = await import('./adapterStore')

    await useAdapterStore.getState().updateConfig({ telegram: { botToken: 'token' } })

    await vi.waitFor(() => {
      expect(restartSidecar).toHaveBeenCalledTimes(1)
    })
  })

  it('does not block config changes when desktop sidecar restart fails', async () => {
    const restartError = new Error('restart failed')
    const restartSidecar = vi.fn().mockRejectedValue(restartError)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      adapters: {
        restartSidecar,
      },
    }

    const { useAdapterStore } = await import('./adapterStore')

    await useAdapterStore.getState().updateConfig({ telegram: { botToken: 'token' } })

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        '[adapterStore] restart_adapters_sidecar failed:',
        restartError,
      )
    })
    expect(adaptersApi.updateConfig).toHaveBeenCalledWith({ telegram: { botToken: 'token' } })

    warn.mockRestore()
  })

  it('removes a WeChat paired user without clearing the bound account', async () => {
    const { useAdapterStore } = await import('./adapterStore')
    useAdapterStore.setState({
      config: {
        wechat: {
          accountId: 'wx-account',
          botToken: '****oken',
          userId: 'wx-login-user',
          pairedUsers: [
            { userId: 'wx-user-1', displayName: 'User 1', pairedAt: 1 },
            { userId: 'wx-user-2', displayName: 'User 2', pairedAt: 2 },
          ],
        },
      },
    })

    await useAdapterStore.getState().removePairedUser('wechat', 'wx-user-1')

    expect(adaptersApi.unbindWechat).not.toHaveBeenCalled()
    expect(adaptersApi.updateConfig).toHaveBeenCalledWith({
      wechat: {
        accountId: 'wx-account',
        botToken: '****oken',
        userId: 'wx-login-user',
        pairedUsers: [{ userId: 'wx-user-2', displayName: 'User 2', pairedAt: 2 }],
      },
    })
  })

  it('unbinds the WeChat account only through the explicit account action', async () => {
    const nextConfig = { wechat: { pairedUsers: [] } }
    adaptersApi.unbindWechat.mockResolvedValue(nextConfig)

    const { useAdapterStore } = await import('./adapterStore')

    await useAdapterStore.getState().unbindWechatAccount()

    expect(adaptersApi.unbindWechat).toHaveBeenCalledTimes(1)
    expect(useAdapterStore.getState().config).toBe(nextConfig)
  })

  it('unbinds the DingTalk bot through the explicit bot action', async () => {
    const nextConfig = { dingtalk: { pairedUsers: [], allowedUsers: [] } }
    adaptersApi.unbindDingtalk.mockResolvedValue(nextConfig)

    const { useAdapterStore } = await import('./adapterStore')

    await useAdapterStore.getState().unbindDingtalkBot()

    expect(adaptersApi.updateConfig).not.toHaveBeenCalled()
    expect(adaptersApi.unbindDingtalk).toHaveBeenCalledTimes(1)
    expect(useAdapterStore.getState().config).toBe(nextConfig)
  })

  it('unbinds the WhatsApp account only through the explicit account action', async () => {
    const nextConfig = { whatsapp: { pairedUsers: [], allowedUsers: [] } }
    adaptersApi.unbindWhatsApp.mockResolvedValue(nextConfig)

    const { useAdapterStore } = await import('./adapterStore')

    await useAdapterStore.getState().unbindWhatsAppAccount()

    expect(adaptersApi.unbindWhatsApp).toHaveBeenCalledTimes(1)
    expect(useAdapterStore.getState().config).toBe(nextConfig)
  })
})
