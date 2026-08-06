/**
 * Adapters API — IM Adapter 配置读写
 *
 * GET  /api/adapters  → 返回配置（敏感字段脱敏）
 * PUT  /api/adapters  → 更新配置（浅合并），返回更新后的脱敏配置
 */

import { adapterService, type AdapterFileConfig, type PairedUser } from '../services/adapterService.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  pollWechatLoginWithQr,
  startWechatLoginWithQr,
  WECHAT_DEFAULT_BASE_URL,
} from '../../../adapters/wechat/protocol.js'
import {
  logoutWhatsAppAuth,
  pollWhatsAppLoginWithQr,
  startWhatsAppLoginWithQr,
} from '../../../adapters/whatsapp/protocol.js'
import { loadConfig } from '../../../adapters/common/config.js'

const ALLOWED_TOP_KEYS = new Set(['serverUrl', 'defaultProjectDir', 'allowedProjectRoots', 'telegram', 'feishu', 'wechat', 'dingtalk', 'whatsapp', 'pairing'])
const MAX_TEXT_LENGTH = 16_384
const MAX_PATH_LENGTH = 4_096
const MAX_LIST_LENGTH = 1_000
const WHATSAPP_STAGING_TTL_MS = 3 * 60 * 1000
const whatsappLoginDirs = new Map<string, {
  stagingDir: string
  targetDir: string
  createdAt: number
}>()

function getAdapterConfigDir(): string {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))
}

function getManagedWhatsAppRoot(): string {
  return path.join(getAdapterConfigDir(), 'whatsapp-auth')
}

function getDefaultManagedWhatsAppAuthDir(): string {
  return path.join(getManagedWhatsAppRoot(), 'default')
}

function isManagedWhatsAppAuthDir(candidate: string): boolean {
  const root = getManagedWhatsAppRoot()
  const resolved = path.resolve(candidate)
  return path.dirname(resolved) === root && path.basename(resolved).length > 0
}

async function removeManagedWhatsAppDir(candidate: string): Promise<void> {
  if (!isManagedWhatsAppAuthDir(candidate)) return
  const stat = await fs.lstat(candidate).catch(() => null)
  if (stat?.isSymbolicLink()) return
  await fs.rm(candidate, { recursive: true, force: true })
}

async function cleanupExpiredWhatsAppStaging(): Promise<void> {
  const now = Date.now()
  for (const [sessionKey, loginDirs] of whatsappLoginDirs) {
    if (now - loginDirs.createdAt <= WHATSAPP_STAGING_TTL_MS) continue
    whatsappLoginDirs.delete(sessionKey)
    await removeManagedWhatsAppDir(loginDirs.stagingDir)
  }
}

export async function cleanupStaleWhatsAppLoginDirectories(): Promise<void> {
  const root = getManagedWhatsAppRoot()
  const entries = await fs.readdir(root).catch(() => [])
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith('.login-')) continue
    const fullPath = path.join(root, entry)
    const stat = await fs.lstat(fullPath).catch(() => null)
    if (!stat || stat.isSymbolicLink()) continue
    if (now - stat.mtimeMs > WHATSAPP_STAGING_TTL_MS) {
      await removeManagedWhatsAppDir(fullPath)
    }
  }
}

cleanupStaleWhatsAppLoginDirectories().catch(() => {})

async function promoteWhatsAppAuth(stagingDir: string, targetDir: string): Promise<void> {
  if (!isManagedWhatsAppAuthDir(stagingDir) || !isManagedWhatsAppAuthDir(targetDir)) {
    throw ApiError.internal('WhatsApp authentication directory is invalid')
  }
  const root = getManagedWhatsAppRoot()
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const backupDir = path.join(root, `.backup-${crypto.randomUUID()}`)
  const targetExists = await fs.lstat(targetDir).then((stat) => !stat.isSymbolicLink()).catch(() => false)
  if (targetExists) await fs.rename(targetDir, backupDir)
  try {
    await fs.rename(stagingDir, targetDir)
    await fs.rm(backupDir, { recursive: true, force: true })
  } catch {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {})
    if (targetExists) await fs.rename(backupDir, targetDir).catch(() => {})
    throw ApiError.internal('Failed to activate WhatsApp authentication')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw ApiError.badRequest(`${label} must be an object`)
  return value
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw ApiError.badRequest(`Unknown ${label} key: ${key}`)
  }
}

function readString(value: unknown, label: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`${label} must be a string`)
  if (value.length > maxLength) throw ApiError.badRequest(`${label} is too long`)
  return value
}

function readStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    throw ApiError.badRequest(`${label} must be an array`)
  }
  return value.map((item, index) => {
    const text = readString(item, `${label}[${index}]`, 1_024).trim()
    if (!text) throw ApiError.badRequest(`${label}[${index}] must not be empty`)
    return text
  })
}

function readTelegramUsers(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    throw ApiError.badRequest('telegram.allowedUsers must be an array')
  }
  return value.map((item, index) => {
    if (!Number.isSafeInteger(item) || Number(item) <= 0) {
      throw ApiError.badRequest(`telegram.allowedUsers[${index}] must be a positive integer`)
    }
    return Number(item)
  })
}

function readPairedUsers(value: unknown, label: string): PairedUser[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    throw ApiError.badRequest(`${label} must be an array`)
  }
  return value.map((item, index) => {
    const user = requireRecord(item, `${label}[${index}]`)
    assertKnownKeys(user, ['userId', 'displayName', 'pairedAt'], `${label}[${index}]`)
    const userId = user.userId
    if (
      !(typeof userId === 'string' && userId.length > 0 && userId.length <= 1_024)
      && !Number.isSafeInteger(userId)
    ) {
      throw ApiError.badRequest(`${label}[${index}].userId is invalid`)
    }
    const displayName = readString(user.displayName, `${label}[${index}].displayName`, 1_024)
    if (typeof user.pairedAt !== 'number' || !Number.isFinite(user.pairedAt) || user.pairedAt < 0) {
      throw ApiError.badRequest(`${label}[${index}].pairedAt is invalid`)
    }
    return { userId: userId as string | number, displayName, pairedAt: user.pairedAt }
  })
}

function readOptionalStringField(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  label: string,
  maxLength = MAX_TEXT_LENGTH,
): void {
  if (key in source) target[key] = readString(source[key], label, maxLength)
}

function readOptionalStringListField(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (key in source) target[key] = readStringList(source[key], label)
}

function parseAdapterConfigPatch(value: unknown): Partial<AdapterFileConfig> {
  const body = requireRecord(value, 'request body')
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_KEYS.has(key)) throw ApiError.badRequest(`Unknown config key: ${key}`)
  }

  const patch: Partial<AdapterFileConfig> = {}
  if ('serverUrl' in body) patch.serverUrl = readString(body.serverUrl, 'serverUrl', 2_048)
  if ('defaultProjectDir' in body) {
    patch.defaultProjectDir = readString(body.defaultProjectDir, 'defaultProjectDir', MAX_PATH_LENGTH)
  }
  if ('allowedProjectRoots' in body) {
    patch.allowedProjectRoots = readStringList(body.allowedProjectRoots, 'allowedProjectRoots')
  }

  if ('pairing' in body) {
    const source = requireRecord(body.pairing, 'pairing')
    assertKnownKeys(source, ['code', 'expiresAt', 'createdAt'], 'pairing')
    const pairing: NonNullable<AdapterFileConfig['pairing']> = {}
    if ('code' in source) {
      if (source.code !== null && (typeof source.code !== 'string' || source.code.length > 64)) {
        throw ApiError.badRequest('pairing.code must be a string or null')
      }
      pairing.code = source.code as string | null
    }
    for (const key of ['expiresAt', 'createdAt'] as const) {
      if (!(key in source)) continue
      const field = source[key]
      if (field !== null && (typeof field !== 'number' || !Number.isFinite(field) || field < 0)) {
        throw ApiError.badRequest(`pairing.${key} must be a non-negative number or null`)
      }
      pairing[key] = field as number | null
    }
    patch.pairing = pairing
  }

  if ('telegram' in body) {
    const source = requireRecord(body.telegram, 'telegram')
    assertKnownKeys(source, ['botToken', 'allowedUsers', 'pairedUsers', 'defaultWorkDir', 'allowedProjectRoots'], 'telegram')
    const telegram: NonNullable<AdapterFileConfig['telegram']> = {}
    readOptionalStringField(source, telegram, 'botToken', 'telegram.botToken')
    if ('allowedUsers' in source) telegram.allowedUsers = readTelegramUsers(source.allowedUsers)
    if ('pairedUsers' in source) telegram.pairedUsers = readPairedUsers(source.pairedUsers, 'telegram.pairedUsers')
    readOptionalStringField(source, telegram, 'defaultWorkDir', 'telegram.defaultWorkDir', MAX_PATH_LENGTH)
    readOptionalStringListField(source, telegram, 'allowedProjectRoots', 'telegram.allowedProjectRoots')
    patch.telegram = telegram
  }

  if ('feishu' in body) {
    const source = requireRecord(body.feishu, 'feishu')
    assertKnownKeys(
      source,
      ['appId', 'appSecret', 'encryptKey', 'verificationToken', 'allowedUsers', 'pairedUsers', 'defaultWorkDir', 'streamingCard', 'allowedProjectRoots'],
      'feishu',
    )
    const feishu: NonNullable<AdapterFileConfig['feishu']> = {}
    for (const key of ['appId', 'appSecret', 'encryptKey', 'verificationToken'] as const) {
      readOptionalStringField(source, feishu, key, `feishu.${key}`)
    }
    readOptionalStringListField(source, feishu, 'allowedUsers', 'feishu.allowedUsers')
    if ('pairedUsers' in source) feishu.pairedUsers = readPairedUsers(source.pairedUsers, 'feishu.pairedUsers')
    readOptionalStringField(source, feishu, 'defaultWorkDir', 'feishu.defaultWorkDir', MAX_PATH_LENGTH)
    readOptionalStringListField(source, feishu, 'allowedProjectRoots', 'feishu.allowedProjectRoots')
    if ('streamingCard' in source) {
      if (typeof source.streamingCard !== 'boolean') throw ApiError.badRequest('feishu.streamingCard must be a boolean')
      feishu.streamingCard = source.streamingCard
    }
    patch.feishu = feishu
  }

  if ('wechat' in body) {
    const source = requireRecord(body.wechat, 'wechat')
    assertKnownKeys(source, ['allowedUsers', 'pairedUsers', 'defaultWorkDir', 'allowedProjectRoots'], 'wechat')
    const wechat: NonNullable<AdapterFileConfig['wechat']> = {}
    readOptionalStringListField(source, wechat, 'allowedUsers', 'wechat.allowedUsers')
    if ('pairedUsers' in source) wechat.pairedUsers = readPairedUsers(source.pairedUsers, 'wechat.pairedUsers')
    readOptionalStringField(source, wechat, 'defaultWorkDir', 'wechat.defaultWorkDir', MAX_PATH_LENGTH)
    readOptionalStringListField(source, wechat, 'allowedProjectRoots', 'wechat.allowedProjectRoots')
    patch.wechat = wechat
  }

  if ('dingtalk' in body) {
    const source = requireRecord(body.dingtalk, 'dingtalk')
    assertKnownKeys(
      source,
      ['clientId', 'clientSecret', 'allowedUsers', 'pairedUsers', 'defaultWorkDir', 'endpoint', 'permissionCardTemplateId', 'allowedProjectRoots'],
      'dingtalk',
    )
    const dingtalk: NonNullable<AdapterFileConfig['dingtalk']> = {}
    for (const key of ['clientId', 'clientSecret', 'endpoint', 'permissionCardTemplateId'] as const) {
      readOptionalStringField(source, dingtalk, key, `dingtalk.${key}`, key === 'endpoint' ? 2_048 : MAX_TEXT_LENGTH)
    }
    readOptionalStringListField(source, dingtalk, 'allowedUsers', 'dingtalk.allowedUsers')
    if ('pairedUsers' in source) dingtalk.pairedUsers = readPairedUsers(source.pairedUsers, 'dingtalk.pairedUsers')
    readOptionalStringField(source, dingtalk, 'defaultWorkDir', 'dingtalk.defaultWorkDir', MAX_PATH_LENGTH)
    readOptionalStringListField(source, dingtalk, 'allowedProjectRoots', 'dingtalk.allowedProjectRoots')
    patch.dingtalk = dingtalk
  }

  if ('whatsapp' in body) {
    const source = requireRecord(body.whatsapp, 'whatsapp')
    assertKnownKeys(source, ['allowedUsers', 'pairedUsers', 'defaultWorkDir', 'allowedProjectRoots'], 'whatsapp')
    const whatsapp: NonNullable<AdapterFileConfig['whatsapp']> = {}
    readOptionalStringListField(source, whatsapp, 'allowedUsers', 'whatsapp.allowedUsers')
    if ('pairedUsers' in source) whatsapp.pairedUsers = readPairedUsers(source.pairedUsers, 'whatsapp.pairedUsers')
    readOptionalStringField(source, whatsapp, 'defaultWorkDir', 'whatsapp.defaultWorkDir', MAX_PATH_LENGTH)
    readOptionalStringListField(source, whatsapp, 'allowedProjectRoots', 'whatsapp.allowedProjectRoots')
    patch.whatsapp = whatsapp
  }

  return patch
}

type RegistrationApiResponse<T extends Record<string, unknown>> = T & {
  errcode: number
  errmsg?: string
}

type RegistrationBeginPayload = {
  deviceCode: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete: string
  expiresInSeconds: number
  intervalSeconds: number
  qrDataUrl?: string
}

const DINGTALK_REGISTRATION_BASE_URL =
  process.env.DINGTALK_REGISTRATION_BASE_URL?.trim() || 'https://oapi.dingtalk.com'
const DINGTALK_REGISTRATION_SOURCE =
  process.env.DINGTALK_REGISTRATION_SOURCE?.trim() || 'DING_DWS_CLAW'

async function postDingtalkRegistration<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
  action: string,
): Promise<RegistrationApiResponse<T>> {
  const res = await fetch(`${DINGTALK_REGISTRATION_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null) as RegistrationApiResponse<T> | null
  if (!res.ok || !data || data.errcode !== 0) {
    throw ApiError.internal(`[DingTalk ${action}] ${data?.errmsg || res.statusText || 'unknown error'}`)
  }
  return data
}

async function createQrDataUrl(text: string): Promise<string | undefined> {
  try {
    const qr = await import('qrcode') as any
    return await qr.toDataURL(text, { margin: 1, width: 220 })
  } catch {
    return undefined
  }
}

async function beginDingtalkRegistration(): Promise<RegistrationBeginPayload> {
  const initData = await postDingtalkRegistration<{ nonce?: string }>(
    '/app/registration/init',
    { source: DINGTALK_REGISTRATION_SOURCE },
    'init',
  )
  const nonce = String(initData.nonce ?? '').trim()
  if (!nonce) throw ApiError.internal('[DingTalk init] missing nonce')

  const beginData = await postDingtalkRegistration<{
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
  }>('/app/registration/begin', { nonce }, 'begin')

  const deviceCode = String(beginData.device_code ?? '').trim()
  const verificationUriComplete = String(beginData.verification_uri_complete ?? '').trim()
  if (!deviceCode) throw ApiError.internal('[DingTalk begin] missing device_code')
  if (!verificationUriComplete) throw ApiError.internal('[DingTalk begin] missing verification_uri_complete')

  const expiresInSeconds = Number(beginData.expires_in ?? 7200)
  const intervalSeconds = Number(beginData.interval ?? 3)

  return {
    deviceCode,
    userCode: String(beginData.user_code ?? '').trim() || undefined,
    verificationUri: String(beginData.verification_uri ?? '').trim() || undefined,
    verificationUriComplete,
    expiresInSeconds: Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 7200,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 3,
    qrDataUrl: await createQrDataUrl(verificationUriComplete),
  }
}

async function pollDingtalkRegistration(deviceCode: string): Promise<Response> {
  if (!deviceCode) throw ApiError.badRequest('deviceCode is required')

  const pollData = await postDingtalkRegistration<{
    status?: string
    client_id?: string
    client_secret?: string
    fail_reason?: string
  }>('/app/registration/poll', { device_code: deviceCode }, 'poll')

  const status = String(pollData.status ?? '').trim().toUpperCase()
  if (status === 'SUCCESS') {
    const clientId = String(pollData.client_id ?? '').trim()
    const clientSecret = String(pollData.client_secret ?? '').trim()
    if (!clientId || !clientSecret) {
      throw ApiError.internal('DingTalk authorization succeeded but credentials are missing')
    }
    await adapterService.updateConfig({
      dingtalk: {
        clientId,
        clientSecret,
      },
    })
    return Response.json({
      status,
      config: await adapterService.getConfig(),
    })
  }

  return Response.json({
    status: status || 'UNKNOWN',
    failReason: String(pollData.fail_reason ?? '').trim() || undefined,
  })
}

export async function handleAdaptersApi(
  req: Request,
  _url: URL,
  _segments: string[],
): Promise<Response> {
  try {
    const tail = _segments.slice(2)
    if (tail[0] === 'wechat') {
      return await handleWechatAdaptersApi(req, tail.slice(1))
    }
    if (tail[0] === 'whatsapp') {
      return await handleWhatsAppAdaptersApi(req, tail.slice(1))
    }
    if (tail[0] === 'dingtalk' && req.method === 'POST' && tail[1] === 'unbind') {
      await adapterService.updateConfig({
        dingtalk: {
          clientId: undefined,
          clientSecret: undefined,
          allowedUsers: [],
          pairedUsers: [],
          permissionCardTemplateId: undefined,
        },
      })
      return Response.json(await adapterService.getConfig())
    }
    if (tail[0] === 'dingtalk' && tail[1] === 'registration') {
      if (req.method === 'POST' && tail[2] === 'begin') {
        return Response.json(await beginDingtalkRegistration())
      }
      if (req.method === 'POST' && tail[2] === 'poll') {
        const body = await req.json().catch(() => {
          throw ApiError.badRequest('Request body must be valid JSON')
        })
        const deviceCode = isRecord(body) ? body.deviceCode : undefined
        if (typeof deviceCode !== 'string' || !deviceCode.trim() || deviceCode.length > 256) {
          throw ApiError.badRequest('deviceCode is required')
        }
        return pollDingtalkRegistration(deviceCode.trim())
      }
    }

    if (req.method === 'GET') {
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    if (req.method === 'PUT') {
      const body = await req.json().catch(() => {
        throw ApiError.badRequest('Request body must be valid JSON')
      })
      await adapterService.updateConfig(parseAdapterConfigPatch(body))
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleWechatAdaptersApi(req: Request, tail: string[]): Promise<Response> {
  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'start') {
    const result = await startWechatLoginWithQr({ force: true })
    return Response.json(result)
  }

  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'poll') {
    const body = await req.json().catch(() => {
      throw ApiError.badRequest('Request body must be valid JSON')
    })
    const sessionKey = isRecord(body) ? body.sessionKey : undefined
    if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 256) {
      throw ApiError.badRequest('Missing or invalid sessionKey')
    }
    const result = await pollWechatLoginWithQr({ sessionKey })
    if (result.connected) {
      await adapterService.updateConfig({
        wechat: {
          accountId: result.accountId,
          botToken: result.botToken,
          baseUrl: result.baseUrl || WECHAT_DEFAULT_BASE_URL,
          userId: result.userId,
          pairedUsers: [],
        },
      })
    }
    return Response.json(result.connected ? await adapterService.getConfig() : result)
  }

  if (req.method === 'POST' && tail[0] === 'unbind') {
    await adapterService.updateConfig({
      wechat: {
        accountId: undefined,
        botToken: undefined,
        baseUrl: WECHAT_DEFAULT_BASE_URL,
        userId: undefined,
        pairedUsers: [],
        allowedUsers: [],
      },
    })
    return Response.json(await adapterService.getConfig())
  }

  throw new ApiError(404, 'Unknown WeChat adapter endpoint', 'NOT_FOUND')
}

async function handleWhatsAppAdaptersApi(req: Request, tail: string[]): Promise<Response> {
  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'start') {
    await cleanupExpiredWhatsAppStaging()
    const config = loadConfig()
    const configuredTarget = path.resolve(config.whatsapp.authDir)
    const targetDir = isManagedWhatsAppAuthDir(configuredTarget)
      ? configuredTarget
      : getDefaultManagedWhatsAppAuthDir()
    const stagingDir = path.join(getManagedWhatsAppRoot(), `.login-${crypto.randomUUID()}`)
    try {
      const result = await startWhatsAppLoginWithQr({
        authDir: stagingDir,
        force: true,
      })
      whatsappLoginDirs.set(result.sessionKey, {
        stagingDir,
        targetDir,
        createdAt: Date.now(),
      })
      return Response.json({
        ...result,
        qrDataUrl: result.qr ? await createQrDataUrl(result.qr) : undefined,
      })
    } catch (error) {
      await removeManagedWhatsAppDir(stagingDir)
      throw error
    }
  }

  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'poll') {
    const body = await req.json().catch(() => {
      throw ApiError.badRequest('Request body must be valid JSON')
    })
    const sessionKey = isRecord(body) ? body.sessionKey : undefined
    if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 256) {
      throw ApiError.badRequest('Missing or invalid sessionKey')
    }
    const loginDirs = whatsappLoginDirs.get(sessionKey)
    if (!loginDirs) {
      return Response.json({
        connected: false,
        status: 'expired',
        message: 'WhatsApp login session expired. Generate a new QR code.',
      })
    }
    const result = await pollWhatsAppLoginWithQr({ sessionKey })
    if (result.connected) {
      whatsappLoginDirs.delete(sessionKey)
      await promoteWhatsAppAuth(loginDirs.stagingDir, loginDirs.targetDir)
      await adapterService.updateConfig({
        whatsapp: {
          accountJid: result.accountJid,
          authDir: loginDirs.targetDir,
          pairedUsers: [],
        },
      })
      return Response.json(await adapterService.getConfig())
    }
    if (result.status === 'expired' || result.status === 'error') {
      whatsappLoginDirs.delete(sessionKey)
      await removeManagedWhatsAppDir(loginDirs.stagingDir)
    }
    return Response.json({
      ...result,
      qrDataUrl: result.qr ? await createQrDataUrl(result.qr) : undefined,
    })
  }

  if (req.method === 'POST' && tail[0] === 'unbind') {
    const config = loadConfig()
    if (isManagedWhatsAppAuthDir(config.whatsapp.authDir)) {
      await logoutWhatsAppAuth(config.whatsapp.authDir)
    }
    await adapterService.updateConfig({
      whatsapp: {
        accountJid: undefined,
        authDir: getDefaultManagedWhatsAppAuthDir(),
        pairedUsers: [],
        allowedUsers: [],
      },
    })
    return Response.json(await adapterService.getConfig())
  }

  throw new ApiError(404, 'Unknown WhatsApp adapter endpoint', 'NOT_FOUND')
}
