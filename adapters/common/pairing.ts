/**
 * 配对核心逻辑
 *
 * - generatePairingCode(): 生成 6 位安全配对码
 * - isPaired(): 检查用户是否已配对（pairedUsers + allowedUsers 并集）
 * - tryPair(): 验证配对码，成功则写入 pairedUsers 并清除 code
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { PairedUser, PairingState } from './config.js'

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 排除 0/O/1/I/L

// 速率限制：每个 userId 在 RATE_LIMIT_WINDOW_MS 内最多 RATE_LIMIT_MAX_ATTEMPTS 次失败尝试
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 5
const failedAttempts = new Map<string, { count: number; firstAttempt: number }>()

function isRateLimited(userId: string | number): boolean {
  const key = String(userId)
  const record = failedAttempts.get(key)
  if (!record) return false
  if (Date.now() - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    failedAttempts.delete(key)
    return false
  }
  return record.count >= RATE_LIMIT_MAX_ATTEMPTS
}

function recordFailedAttempt(userId: string | number): void {
  const key = String(userId)
  const record = failedAttempts.get(key)
  if (!record || Date.now() - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    failedAttempts.set(key, { count: 1, firstAttempt: Date.now() })
  } else {
    record.count++
  }
}
const CODE_LENGTH = 6
const CODE_TTL_MS = 60 * 60 * 1000 // 60 minutes

function getConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'adapters.json')
}

function readConfigFile(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function writeConfigFile(data: Record<string, any>): void {
  const filePath = getConfigPath()
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function generatePairingCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += SAFE_ALPHABET[crypto.randomInt(SAFE_ALPHABET.length)]
  }
  return code
}

/** 检查用户是否已配对（pairedUsers + allowedUsers 并集） */
export function isPaired(
  platform: 'telegram' | 'feishu',
  userId: string | number,
  config: Record<string, any>,
): boolean {
  const platformConfig = config[platform] ?? {}
  const allowedUsers: (string | number)[] = platformConfig.allowedUsers ?? []
  const pairedUsers: PairedUser[] = platformConfig.pairedUsers ?? []

  // allowedUsers 非空时检查
  if (allowedUsers.length > 0 && allowedUsers.includes(userId)) return true
  // 默认关闭：没有配置任何用户时拒绝访问（需要先配对）
  if (pairedUsers.length === 0 && allowedUsers.length === 0) return false

  return pairedUsers.some((p) => String(p.userId) === String(userId))
}

/**
 * 尝试配对：验证消息文本是否匹配当前有效配对码。
 * 成功则写入 pairedUsers 并清除 pairing.code，返回 true。
 */
export function tryPair(
  messageText: string,
  senderInfo: { userId: string | number; displayName: string },
  platform: 'telegram' | 'feishu',
): boolean {
  const file = readConfigFile()
  const pairing: PairingState = file.pairing ?? { code: null, expiresAt: null, createdAt: null }

  // 速率限制检查
  if (isRateLimited(senderInfo.userId)) return false

  // 检查配对码是否有效
  if (!pairing.code || !pairing.expiresAt) return false
  if (Date.now() > pairing.expiresAt) return false

  // 比较（忽略大小写和空格）
  const input = messageText.trim().toUpperCase()
  if (input !== pairing.code.toUpperCase()) {
    recordFailedAttempt(senderInfo.userId)
    return false
  }

  // 配对成功：写入 pairedUsers
  const platformConfig = file[platform] ?? {}
  const pairedUsers: PairedUser[] = platformConfig.pairedUsers ?? []

  // 避免重复
  const exists = pairedUsers.some((p) => String(p.userId) === String(senderInfo.userId))
  if (!exists) {
    pairedUsers.push({
      userId: senderInfo.userId,
      displayName: senderInfo.displayName,
      pairedAt: Date.now(),
    })
  }

  // 更新 config
  file[platform] = { ...platformConfig, pairedUsers }
  file.pairing = { code: null, expiresAt: null, createdAt: null } // 一次性使用
  writeConfigFile(file)

  return true
}

/** 统一的用户授权检查（供各 adapter 调用） */
export function isAllowedUser(platform: 'telegram' | 'feishu', userId: string | number): boolean {
  try {
    const cfgFile = readConfigFile()
    return isPaired(platform, userId, cfgFile)
  } catch {
    return false
  }
}
