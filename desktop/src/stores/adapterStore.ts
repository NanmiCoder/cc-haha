import { create } from 'zustand'
import { adaptersApi } from '../api/adapters'
import type { AdapterFileConfig } from '../types/adapter'
import type { DingtalkRegistrationBegin, DingtalkRegistrationPoll } from '../api/adapters'
import { getDesktopHost } from '../lib/desktopHost'

/**
 * Desktop host trigger: let the app process kill + respawn adapter sidecar,
 * 让 ~/.claude/adapters.json 里的最新凭据被新进程读到，建立飞书 / Telegram / 微信 / 钉钉 / WhatsApp
 * 的 WebSocket 连接。
 *
 * 在非桌面环境（纯浏览器调试 / 单元测试）这会安静跳过 —— 那种场景下
 * 本来也没有 sidecar 可重启。
 */
async function notifyDesktopRestartAdapters(): Promise<void> {
  const host = getDesktopHost()
  if (!host.isDesktop) return

  try {
    await host.adapters.restartSidecar()
  } catch (err) {
    // 不阻塞保存流程 —— 配置文件已经写入，下次启动 App 也会生效
    if (typeof console !== 'undefined') {
      console.warn('[adapterStore] restart_adapters_sidecar failed:', err)
    }
  }
}

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const CODE_TTL_MS = 60 * 60 * 1000 // 60 minutes

function generateCode(): string {
  const maxValid = Math.floor(256 / SAFE_ALPHABET.length) * SAFE_ALPHABET.length
  let code = ''
  while (code.length < CODE_LENGTH) {
    const array = new Uint8Array(1)
    crypto.getRandomValues(array)
    if (array[0]! < maxValid) {
      code += SAFE_ALPHABET[array[0]! % SAFE_ALPHABET.length]
    }
  }
  return code
}

type AdapterStore = {
  config: AdapterFileConfig
  isLoading: boolean
  error: string | null

  fetchConfig: () => Promise<void>
  updateConfig: (patch: Partial<AdapterFileConfig>) => Promise<void>
  generatePairingCode: () => Promise<string>
  startWechatLogin: () => Promise<{ qrcodeUrl?: string; message: string; sessionKey: string }>
  pollWechatLogin: (sessionKey: string) => Promise<{ connected: boolean; status?: string; message?: string }>
  startWhatsAppLogin: () => Promise<{ qrDataUrl?: string; message: string; sessionKey: string }>
  pollWhatsAppLogin: (sessionKey: string) => Promise<{ connected: boolean; status?: string; message?: string; qrDataUrl?: string }>
  removePairedUser: (platform: 'telegram' | 'feishu' | 'wechat' | 'dingtalk' | 'whatsapp', userId: string | number) => Promise<void>
  beginDingtalkRegistration: () => Promise<DingtalkRegistrationBegin>
  pollDingtalkRegistration: (deviceCode: string) => Promise<DingtalkRegistrationPoll>
  unbindWechatAccount: () => Promise<void>
  unbindDingtalkBot: () => Promise<void>
  unbindWhatsAppAccount: () => Promise<void>
}

export const useAdapterStore = create<AdapterStore>((set, get) => ({
  config: {},
  isLoading: false,
  error: null,

  fetchConfig: async () => {
    set({ isLoading: true, error: null })
    try {
      const config = await adaptersApi.getConfig()
      set({ config, isLoading: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load config'
      set({ isLoading: false, error: message })
    }
  },

  updateConfig: async (patch) => {
    const config = await adaptersApi.updateConfig(patch)
    set({ config })
    // 配置文件已写入磁盘，让 Tauri 主进程 kill + respawn adapter sidecar，
    // 触发各 IM adapter 用新凭据重连。pairing code / paired users
    // 这种轻量更新也会触发重启 —— 这是个有意为之的简化：保证"任何配置变更
    // 都立刻生效"，比起精细判断哪些字段值得重启更可靠。
    void notifyDesktopRestartAdapters()
  },

  generatePairingCode: async () => {
    const code = generateCode()
    const now = Date.now()
    await get().updateConfig({
      pairing: {
        code,
        expiresAt: now + CODE_TTL_MS,
        createdAt: now,
      },
    })
    return code
  },

  startWechatLogin: async () => {
    return adaptersApi.startWechatLogin()
  },

  pollWechatLogin: async (sessionKey) => {
    const result = await adaptersApi.pollWechatLogin(sessionKey)
    if ('connected' in result && result.connected === false) {
      return { connected: false, status: result.status, message: result.message }
    }
    if ('wechat' in result || 'telegram' in result || 'feishu' in result || 'dingtalk' in result) {
      set({ config: result })
      void notifyDesktopRestartAdapters()
      return { connected: true }
    }
    return { connected: false }
  },

  startWhatsAppLogin: async () => {
    return adaptersApi.startWhatsAppLogin()
  },

  pollWhatsAppLogin: async (sessionKey) => {
    const result = await adaptersApi.pollWhatsAppLogin(sessionKey)
    if ('connected' in result && result.connected === false) {
      return {
        connected: false,
        status: result.status,
        message: result.message,
        qrDataUrl: result.qrDataUrl,
      }
    }
    if ('whatsapp' in result || 'wechat' in result || 'telegram' in result || 'feishu' in result || 'dingtalk' in result) {
      set({ config: result })
      void notifyDesktopRestartAdapters()
      return { connected: true }
    }
    return { connected: false }
  },

  beginDingtalkRegistration: () => adaptersApi.beginDingtalkRegistration(),

  pollDingtalkRegistration: async (deviceCode) => {
    const result = await adaptersApi.pollDingtalkRegistration(deviceCode)
    if (result.config) {
      set({ config: result.config })
      void notifyDesktopRestartAdapters()
    }
    return result
  },

  unbindWechatAccount: async () => {
    const config = await adaptersApi.unbindWechat()
    set({ config })
    void notifyDesktopRestartAdapters()
  },

  unbindDingtalkBot: async () => {
    const config = await adaptersApi.unbindDingtalk()
    set({ config })
    void notifyDesktopRestartAdapters()
  },

  unbindWhatsAppAccount: async () => {
    const config = await adaptersApi.unbindWhatsApp()
    set({ config })
    void notifyDesktopRestartAdapters()
  },

  removePairedUser: async (platform, userId) => {
    const { config } = get()
    const platformConfig = config[platform]
    if (!platformConfig) return

    const pairedUsers = (platformConfig.pairedUsers ?? []).filter(
      (u) => String(u.userId) !== String(userId),
    )

    await get().updateConfig({
      [platform]: { ...platformConfig, pairedUsers },
    })
  },
}))
