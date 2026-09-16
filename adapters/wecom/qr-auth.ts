/**
 * Enterprise WeChat (企业微信) AI-bot QR provisioning.
 *
 * The 企业微信 console exposes a scan-to-create flow for 智能机器人: a GET
 * returns a short code plus an authorization URL, the admin scans it in the
 * WeCom app, and a second GET hands back the bot's `botid` / `secret`. Those
 * two values are everything the WebSocket runtime needs, so binding never
 * requires the user to open the admin console or copy a secret by hand.
 *
 * Shaped like `adapters/wechat/protocol.ts`: the module owns the in-flight
 * login sessions so the HTTP API stays a thin start/poll pair.
 */

import * as crypto from 'node:crypto'

const GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate'
const POLL_URL = 'https://work.weixin.qq.com/ai/qc/query_result'
const REQUEST_TIMEOUT_MS = 10_000
/** The console invalidates a scan code after five minutes. */
const QR_TTL_MS = 5 * 60_000
export const WECOM_POLL_INTERVAL_MS = 3_000

const DEFAULT_SOURCE = 'claude-code-haha'

type WecomLoginSession = {
  sessionKey: string
  scode: string
  verificationUrl: string
  startedAt: number
}

export type WecomQrStartResult = {
  sessionKey: string
  verificationUrl: string
  expiresAt: number
  pollIntervalMs: number
  message: string
}

export type WecomQrPollResult =
  | { connected: true; botId: string; secret: string }
  | { connected: false; status: 'waiting' | 'expired' | 'failed' | 'not_started'; message: string }

const activeLogins = new Map<string, WecomLoginSession>()

function isFresh(session: WecomLoginSession): boolean {
  return Date.now() - session.startedAt < QR_TTL_MS
}

function purgeExpiredLogins(): void {
  for (const [key, session] of activeLogins) {
    if (!isFresh(session)) activeLogins.delete(key)
  }
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Only the console's own HTTPS origin may be turned into a QR image. */
function safeVerificationUrl(value: unknown): string | null {
  const raw = cleanString(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    const safeHost = url.hostname === 'work.weixin.qq.com'
    const safePort = !url.port || url.port === '443'
    if (url.protocol !== 'https:' || !safeHost || !safePort) return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

function currentPlatformCode(platform: NodeJS.Platform = process.platform): 1 | 2 | 3 {
  if (platform === 'win32') return 2
  if (platform === 'linux') return 3
  return 1
}

async function requestJson(url: URL, fetchImpl: typeof fetch): Promise<Record<string, any>> {
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`Enterprise WeChat QR service returned HTTP ${response.status}`)
  }
  const body = await response.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Enterprise WeChat QR service returned a non-JSON response')
  }
  return body as Record<string, any>
}

export async function startWecomQrLogin(
  opts: { force?: boolean; sessionKey?: string; source?: string; fetchImpl?: typeof fetch } = {},
): Promise<WecomQrStartResult> {
  purgeExpiredLogins()

  const sessionKey = opts.sessionKey || crypto.randomUUID()
  const existing = activeLogins.get(sessionKey)
  if (!opts.force && existing && isFresh(existing)) {
    return {
      sessionKey,
      verificationUrl: existing.verificationUrl,
      expiresAt: existing.startedAt + QR_TTL_MS,
      pollIntervalMs: WECOM_POLL_INTERVAL_MS,
      message: '二维码已就绪，请使用企业微信扫描。',
    }
  }

  const url = new URL(GENERATE_URL)
  url.searchParams.set('source', opts.source || DEFAULT_SOURCE)
  url.searchParams.set('plat', String(currentPlatformCode()))

  const body = await requestJson(url, opts.fetchImpl ?? fetch)
  const scode = cleanString(body?.data?.scode)
  const verificationUrl = safeVerificationUrl(body?.data?.auth_url)
  if (!scode || !verificationUrl) {
    throw new Error('Enterprise WeChat QR service returned invalid data')
  }

  const startedAt = Date.now()
  activeLogins.set(sessionKey, { sessionKey, scode, verificationUrl, startedAt })

  return {
    sessionKey,
    verificationUrl,
    expiresAt: startedAt + QR_TTL_MS,
    pollIntervalMs: WECOM_POLL_INTERVAL_MS,
    message: '使用企业微信扫描二维码，创建并授权智能机器人。',
  }
}

export async function pollWecomQrLogin(
  opts: { sessionKey: string; fetchImpl?: typeof fetch },
): Promise<WecomQrPollResult> {
  purgeExpiredLogins()

  const session = activeLogins.get(opts.sessionKey)
  if (!session) {
    return {
      connected: false,
      status: 'not_started',
      message: '当前没有进行中的企业微信绑定，请重新生成二维码。',
    }
  }

  const url = new URL(POLL_URL)
  url.searchParams.set('scode', session.scode)
  const body = await requestJson(url, opts.fetchImpl ?? fetch)
  const status = cleanString(body?.data?.status)?.toLowerCase()

  if (status === 'success') {
    const botId = cleanString(body?.data?.bot_info?.botid)
    const secret = cleanString(body?.data?.bot_info?.secret)
    if (!botId || !secret) {
      activeLogins.delete(opts.sessionKey)
      return {
        connected: false,
        status: 'failed',
        message: '企业微信返回的机器人凭据不完整，请重新扫码。',
      }
    }
    activeLogins.delete(opts.sessionKey)
    return { connected: true, botId, secret }
  }

  if (status === 'expired' || status === 'timeout') {
    activeLogins.delete(opts.sessionKey)
    return { connected: false, status: 'expired', message: '二维码已过期，请重新生成。' }
  }

  if (status === 'fail' || status === 'failed' || status === 'error') {
    activeLogins.delete(opts.sessionKey)
    return { connected: false, status: 'failed', message: '企业微信授权失败，请重新扫码。' }
  }

  return { connected: false, status: 'waiting', message: '等待企业微信扫码确认...' }
}

/** Drop an in-flight attempt (user cancelled or rebound). */
export function cancelWecomQrLogin(sessionKey: string): void {
  activeLogins.delete(sessionKey)
}

/** Test seam: the module-level session map must not leak across test cases. */
export function resetWecomQrLoginsForTest(): void {
  activeLogins.clear()
}
