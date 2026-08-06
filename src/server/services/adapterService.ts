/**
 * Adapter Service — 读写 IM Adapter 配置文件
 *
 * 配置文件：~/.claude/adapters.json
 * 原子写入：先写临时文件，再 rename
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { ApiError } from '../middleware/errorHandler.js'

export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type PairingState = {
  code?: string | null
  expiresAt?: number | null
  createdAt?: number | null
}

export type AdapterFileConfig = {
  serverUrl?: string
  defaultProjectDir?: string
  allowedProjectRoots?: string[]
  pairing?: PairingState
  telegram?: {
    botToken?: string
    allowedUsers?: number[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
  feishu?: {
    appId?: string
    appSecret?: string
    encryptKey?: string
    verificationToken?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
    streamingCard?: boolean
  }
  wechat?: {
    accountId?: string
    botToken?: string
    baseUrl?: string
    userId?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
  dingtalk?: {
    clientId?: string
    clientSecret?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
    endpoint?: string
    permissionCardTemplateId?: string
  }
  whatsapp?: {
    accountJid?: string
    authDir?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    allowedProjectRoots?: string[]
  }
}

function getConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'adapters.json')
}

function maskSecret(value: string | undefined): string | undefined {
  if (!value) return value
  if (value.length <= 4) return '****'
  return '****' + value.slice(-4)
}

function isMasked(value: string | undefined): boolean {
  return !!value && value.startsWith('****')
}

class AdapterService {
  private updateQueue: Promise<void> = Promise.resolve()

  /** 读取原始配置（不脱敏） */
  async getRawConfig(): Promise<AdapterFileConfig> {
    try {
      const raw = await fs.readFile(getConfigPath(), 'utf-8')
      return JSON.parse(raw) as AdapterFileConfig
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      console.error('[AdapterService] Failed to read adapter config:', err)
      throw ApiError.internal('Failed to read adapter config')
    }
  }

  /** 读取配置（敏感字段脱敏） */
  async getConfig(): Promise<AdapterFileConfig> {
    const config = await this.getRawConfig()
    if (config.telegram?.botToken) {
      config.telegram.botToken = maskSecret(config.telegram.botToken)
    }
    if (config.feishu) {
      if (config.feishu.appSecret) config.feishu.appSecret = maskSecret(config.feishu.appSecret)
      if (config.feishu.encryptKey) config.feishu.encryptKey = maskSecret(config.feishu.encryptKey)
      if (config.feishu.verificationToken) config.feishu.verificationToken = maskSecret(config.feishu.verificationToken)
    }
    if (config.wechat?.botToken) {
      config.wechat.botToken = maskSecret(config.wechat.botToken)
    }
    if (config.dingtalk?.clientSecret) {
      config.dingtalk.clientSecret = maskSecret(config.dingtalk.clientSecret)
    }
    if (config.pairing?.code) {
      config.pairing.code = '******'
    }
    return config
  }

  /** 更新配置（浅合并，敏感字段如果是脱敏值则保留原值） */
  async updateConfig(patch: Partial<AdapterFileConfig>): Promise<void> {
    const update = this.updateQueue.then(() => this.applyConfigPatch(patch))
    this.updateQueue = update.catch(() => {})
    return update
  }

  private async applyConfigPatch(patch: Partial<AdapterFileConfig>): Promise<void> {
    const current = await this.getRawConfig()

    // 保留已存储的密钥（如果前端传回的是脱敏值）
    if (patch.telegram && isMasked(patch.telegram.botToken)) {
      patch.telegram.botToken = current.telegram?.botToken
    }
    if (patch.feishu) {
      if (isMasked(patch.feishu.appSecret)) patch.feishu.appSecret = current.feishu?.appSecret
      if (isMasked(patch.feishu.encryptKey)) patch.feishu.encryptKey = current.feishu?.encryptKey
      if (isMasked(patch.feishu.verificationToken)) patch.feishu.verificationToken = current.feishu?.verificationToken
    }
    if (patch.wechat && isMasked(patch.wechat.botToken)) {
      patch.wechat.botToken = current.wechat?.botToken
    }
    if (patch.dingtalk && isMasked(patch.dingtalk.clientSecret)) {
      patch.dingtalk.clientSecret = current.dingtalk?.clientSecret
    }
    if (patch.pairing && isMasked(patch.pairing.code ?? undefined)) {
      patch.pairing.code = current.pairing?.code
    }

    const merged: AdapterFileConfig = {
      ...current,
      ...patch,
      telegram: patch.telegram ? { ...current.telegram, ...patch.telegram } : current.telegram,
      feishu: patch.feishu ? { ...current.feishu, ...patch.feishu } : current.feishu,
      wechat: patch.wechat ? { ...current.wechat, ...patch.wechat } : current.wechat,
      dingtalk: patch.dingtalk ? { ...current.dingtalk, ...patch.dingtalk } : current.dingtalk,
      whatsapp: patch.whatsapp ? { ...current.whatsapp, ...patch.whatsapp } : current.whatsapp,
      pairing: patch.pairing !== undefined ? { ...current.pairing, ...patch.pairing } : current.pairing,
    }

    await this.writeConfig(merged)
  }

  private async writeConfig(data: AdapterFileConfig): Promise<void> {
    const filePath = getConfigPath()
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })

    const tmpFile = `${filePath}.tmp.${crypto.randomUUID()}`
    try {
      await fs.writeFile(tmpFile, JSON.stringify(data, null, 2) + '\n', {
        encoding: 'utf-8',
        mode: 0o600,
      })
      await fs.rename(tmpFile, filePath)
      await fs.chmod(filePath, 0o600).catch(() => {})
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {})
      console.error('[AdapterService] Failed to write adapter config:', err)
      throw ApiError.internal('Failed to write adapter config')
    }
  }
}

export const adapterService = new AdapterService()
