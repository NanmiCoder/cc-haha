import { create } from 'zustand'
import { adaptersApi } from '../api/adapters'
import type { AdapterFileConfig } from '../types/adapter'

/**
 * Tauri command 触发器：让主进程 kill + respawn adapter sidecar，
 * 让 ~/.claude/adapters.json 里的最新凭据被新进程读到，建立飞书 / Telegram
 * 的 WebSocket 连接。
 *
 * 在非 Tauri 环境（纯浏览器调试 / 单元测试）这会安静失败 —— 那种场景下
 * 本来也没有 sidecar 可重启。
 */
async function notifyTauriRestartAdapters(): Promise<void> {
  try {
    // 用 dynamic import 避开 SSR / non-tauri 测试环境的硬依赖
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('restart_adapters_sidecar')
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
  removePairedUser: (platform: 'telegram' | 'feishu', userId: string | number) => Promise<void>
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
    // 触发飞书 / Telegram WebSocket 用新凭据重连。pairing code / paired users
    // 这种轻量更新也会触发重启 —— 这是个有意为之的简化：保证"任何配置变更
    // 都立刻生效"，比起精细判断哪些字段值得重启更可靠。
    void notifyTauriRestartAdapters()
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
