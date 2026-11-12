/**
 * Core pairing logic
 *
 * - generatePairingCode(): generate a secure 6-character pairing code
 * - isPaired(): check whether a user is paired (union of pairedUsers + allowedUsers)
 * - tryPair(): verify the pairing code; on success write pairedUsers and clear the code
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { PairedUser, PairingState } from './config.js'

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // excludes 0/O/1/I/L
export type ImPlatform =
  | 'telegram'
  | 'feishu'
  | 'wechat'
  | 'dingtalk'
  | 'whatsapp'
  | 'wecom'
  | 'qq'
  | 'slack'

// Rate limit: at most RATE_LIMIT_MAX_ATTEMPTS failed attempts per userId within RATE_LIMIT_WINDOW_MS
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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp.${crypto.randomBytes(8).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, filePath)
}

export function generatePairingCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += SAFE_ALPHABET[crypto.randomInt(SAFE_ALPHABET.length)]
  }
  return code
}

/** Check whether a user is paired (union of pairedUsers + allowedUsers) */
export function isPaired(
  platform: ImPlatform,
  userId: string | number,
  config: Record<string, any>,
): boolean {
  const platformConfig = config[platform] ?? {}
  const allowedUsers: (string | number)[] = platformConfig.allowedUsers ?? []
  const pairedUsers: PairedUser[] = platformConfig.pairedUsers ?? []

  // Check when allowedUsers is non-empty
  if (allowedUsers.length > 0 && allowedUsers.includes(userId)) return true
  // Closed by default: deny access when no users are configured (pairing required first)
  if (pairedUsers.length === 0 && allowedUsers.length === 0) return false

  return pairedUsers.some((p) => String(p.userId) === String(userId))
}

/**
 * Try pairing: verify whether the message text matches the currently valid pairing code.
 * On success write pairedUsers, clear pairing.code and return true.
 */
export function tryPair(
  messageText: string,
  senderInfo: { userId: string | number; displayName: string },
  platform: ImPlatform,
): boolean {
  const file = readConfigFile()
  const pairing: PairingState = file.pairing ?? { code: null, expiresAt: null, createdAt: null }

  // Rate limit check
  if (isRateLimited(senderInfo.userId)) return false

  // Check whether the pairing code is valid
  if (!pairing.code || !pairing.expiresAt) return false
  if (Date.now() > pairing.expiresAt) return false

  // Compare (ignoring case and whitespace)
  const input = messageText.trim().toUpperCase()
  if (input !== pairing.code.toUpperCase()) {
    recordFailedAttempt(senderInfo.userId)
    return false
  }

  // Paired: write pairedUsers
  const platformConfig = file[platform] ?? {}
  const pairedUsers: PairedUser[] = platformConfig.pairedUsers ?? []

  // Avoid duplicates
  const exists = pairedUsers.some((p) => String(p.userId) === String(senderInfo.userId))
  if (!exists) {
    pairedUsers.push({
      userId: senderInfo.userId,
      displayName: senderInfo.displayName,
      pairedAt: Date.now(),
    })
  }

  // Update config
  file[platform] = { ...platformConfig, pairedUsers }
  file.pairing = { code: null, expiresAt: null, createdAt: null } // single use
  writeConfigFile(file)

  return true
}

/** Shared user authorization check (called by each adapter) */
export function isAllowedUser(platform: ImPlatform, userId: string | number): boolean {
  try {
    const cfgFile = readConfigFile()
    return isPaired(platform, userId, cfgFile)
  } catch {
    return false
  }
}
