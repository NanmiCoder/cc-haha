/**
 * Feishu / Lark scan-to-create bot provisioning.
 *
 * Until now, connecting Feishu meant sending the user to the open platform to
 * create an app by hand and paste an App ID and App Secret back. Feishu also
 * exposes an RFC 8628 device-authorization flow at
 * `accounts.feishu.cn/oauth/v1/app/registration`: the desktop asks for a device
 * code, renders the returned URL as a QR code, and the user scans it in Feishu,
 * confirms a pre-filled app (name, description, scopes, events, callbacks) and
 * the poll returns `client_id` / `client_secret` directly.
 *
 * The protocol is implemented here rather than taken from
 * `@larksuiteoapi/node-sdk` on purpose: `registerApp` only landed in 1.73 (this
 * repo pins 1.60 for the chat client), it runs the whole poll inside one
 * un-cancellable promise, and the desktop needs the stateless begin/poll pair
 * that the DingTalk registration already uses. What we borrow from the SDK is
 * the wire format, which is why the details below are spelled out.
 */

import * as crypto from 'node:crypto'
import { gzipSync } from 'node:zlib'

const FEISHU_ACCOUNTS_DOMAIN = 'accounts.feishu.cn'
const LARK_ACCOUNTS_DOMAIN = 'accounts.larksuite.com'
const REGISTRATION_PATH = '/oauth/v1/app/registration'
const REQUEST_TIMEOUT_MS = 15_000
const SESSION_TTL_MS = 30 * 60_000

/** Hosts allowed to appear in a verification URL we turn into a QR image. */
const ALLOWED_VERIFICATION_HOSTS = new Set([
  'accounts.feishu.cn',
  'open.feishu.cn',
  'accounts.larksuite.com',
  'open.larksuite.com',
])

/**
 * Scopes this repository's Feishu adapter actually calls.
 *
 * `im.message.receive_v1` needs the p2p read scope; `im.message.create` /
 * `reply` / `patch` need send-as-bot; `im.messageResource.get`,
 * `im.image.create` and `im.file.create` need `im:resource`; the streaming card
 * needs the CardKit write scope. Nothing here is speculative — adding a scope
 * without a call site means asking the user to grant access we never use.
 */
export const FEISHU_REQUIRED_SCOPES = [
  'im:message.p2p_msg:readonly',
  'im:message:readonly',
  'im:message:send_as_bot',
  'im:resource',
  'cardkit:card:write',
] as const

export const FEISHU_REQUIRED_EVENTS = ['im.message.receive_v1'] as const
export const FEISHU_REQUIRED_CALLBACKS = ['card.action.trigger'] as const

export type FeishuRegistrationBegin = {
  sessionKey: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
  message: string
}

export type FeishuRegistrationPoll =
  | { status: 'success'; appId: string; appSecret: string; domain: 'feishu' | 'lark'; openId?: string }
  | { status: 'waiting'; intervalSeconds: number; message: string }
  | { status: 'expired' | 'denied' | 'failed' | 'not_started'; message: string }

type RegistrationSession = {
  sessionKey: string
  deviceCode: string
  accountsDomain: string
  domain: 'feishu' | 'lark'
  intervalSeconds: number
  domainSwitched: boolean
  startedAt: number
  expiresAt: number
}

type RegistrationResponse = {
  device_code?: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
  client_id?: string
  client_secret?: string
  user_info?: { open_id?: string; tenant_brand?: string }
  error?: string
  error_description?: string
}

const sessions = new Map<string, RegistrationSession>()

/**
 * Incremental app configuration pre-filled into the confirmation page.
 *
 * The payload travels on the URL as gzip → base64 → URL-safe → unpadded, a
 * shape fixed by the platform. `preset: false` drops Feishu's default template
 * so the user is asked for exactly the five scopes above and nothing more.
 */
export function encodeFeishuAddons(addons: Record<string, unknown>): string {
  return gzipSync(Buffer.from(JSON.stringify(addons), 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function defaultAddons(): Record<string, unknown> {
  return {
    preset: false,
    scopes: { tenant: [...FEISHU_REQUIRED_SCOPES] },
    events: { items: { tenant: [...FEISHU_REQUIRED_EVENTS] } },
    callbacks: { items: [...FEISHU_REQUIRED_CALLBACKS] },
  }
}

/**
 * Reject a verification URL that is not a plain Feishu/Lark HTTPS page.
 *
 * The URL is rendered as a QR code the user is told to scan, so a redirected
 * or credentialed URL would be a phishing vector wearing our UI.
 */
export function assertFeishuVerificationUrl(value: string | undefined): URL {
  if (!value) throw new Error('Feishu registration returned no verification URL')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Feishu registration returned an invalid verification URL')
  }
  const safePort = !url.port || url.port === '443'
  if (
    url.protocol !== 'https:'
    || !ALLOWED_VERIFICATION_HOSTS.has(url.hostname)
    || !safePort
    || url.username
    || url.password
  ) {
    throw new Error('Feishu registration returned an unsafe verification URL')
  }
  return url
}

async function requestRegistration(
  accountsDomain: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<RegistrationResponse> {
  const response = await fetchImpl(`https://${accountsDomain}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  // RFC 8628 delivers authorization_pending / slow_down with HTTP 400, so the
  // body has to be read on failure too — only a missing body is a transport
  // error.
  const data = (await response.json().catch(() => null)) as RegistrationResponse | null
  if (!data) {
    throw new Error(`Feishu registration returned HTTP ${response.status}`)
  }
  return data
}

function purgeExpiredSessions(): void {
  const now = Date.now()
  for (const [key, session] of sessions) {
    if (now - session.startedAt > SESSION_TTL_MS || now > session.expiresAt) {
      sessions.delete(key)
    }
  }
}

export type BeginFeishuRegistrationOptions = {
  sessionKey?: string
  /** Identifies this client on the confirmation page. */
  source?: string
  /** Pre-filled app name / description; the user can still edit them. */
  appName?: string
  appDescription?: string
  /** Start on Lark's account domain for international tenants. */
  domain?: 'feishu' | 'lark'
  fetchImpl?: typeof fetch
}

export async function beginFeishuRegistration(
  options: BeginFeishuRegistrationOptions = {},
): Promise<FeishuRegistrationBegin> {
  purgeExpiredSessions()

  const fetchImpl = options.fetchImpl ?? fetch
  const domain = options.domain === 'lark' ? 'lark' : 'feishu'
  const accountsDomain = domain === 'lark' ? LARK_ACCOUNTS_DOMAIN : FEISHU_ACCOUNTS_DOMAIN

  const begun = await requestRegistration(
    accountsDomain,
    {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    },
    fetchImpl,
  )
  if (begun.error) {
    throw new Error(`Feishu registration failed: ${begun.error_description || begun.error}`)
  }

  const deviceCode = begun.device_code?.trim()
  if (!deviceCode) throw new Error('Feishu registration returned no device code')

  const verificationUrl = assertFeishuVerificationUrl(begun.verification_uri_complete)
  verificationUrl.searchParams.set('from', 'sdk')
  verificationUrl.searchParams.set('source', options.source || 'claude-code-haha')
  verificationUrl.searchParams.set('tp', 'sdk')
  // Only ever create a new app: binding an existing one would let this flow
  // overwrite the callback configuration of a bot the user already runs.
  verificationUrl.searchParams.set('createOnly', 'true')
  if (options.appName) verificationUrl.searchParams.set('name', options.appName)
  if (options.appDescription) verificationUrl.searchParams.set('desc', options.appDescription)
  verificationUrl.searchParams.set('addons', encodeFeishuAddons(defaultAddons()))

  const expiresInSeconds = Number.isFinite(Number(begun.expires_in)) && Number(begun.expires_in) > 0
    ? Number(begun.expires_in)
    : 600
  const intervalSeconds = Number.isFinite(Number(begun.interval)) && Number(begun.interval) > 0
    ? Number(begun.interval)
    : 5

  const sessionKey = options.sessionKey || crypto.randomUUID()
  const startedAt = Date.now()
  sessions.set(sessionKey, {
    sessionKey,
    deviceCode,
    accountsDomain,
    domain,
    intervalSeconds,
    domainSwitched: false,
    startedAt,
    expiresAt: startedAt + expiresInSeconds * 1000,
  })

  return {
    sessionKey,
    verificationUri: verificationUrl.toString(),
    expiresInSeconds,
    intervalSeconds,
    message: '使用飞书扫描二维码，确认后会自动创建机器人。',
  }
}

export async function pollFeishuRegistration(options: {
  sessionKey: string
  fetchImpl?: typeof fetch
}): Promise<FeishuRegistrationPoll> {
  purgeExpiredSessions()

  const session = sessions.get(options.sessionKey)
  if (!session) {
    return {
      status: 'not_started',
      message: '当前没有进行中的飞书扫码，请重新生成二维码。',
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  let data = await requestRegistration(
    session.accountsDomain,
    { action: 'poll', device_code: session.deviceCode },
    fetchImpl,
  )

  // An international tenant finishes the flow on Lark's domain. The switch is
  // one-way and happens once, mirroring the official SDK.
  if (data.user_info?.tenant_brand === 'lark' && !session.domainSwitched) {
    session.domainSwitched = true
    session.domain = 'lark'
    session.accountsDomain = LARK_ACCOUNTS_DOMAIN
    data = await requestRegistration(
      session.accountsDomain,
      { action: 'poll', device_code: session.deviceCode },
      fetchImpl,
    )
  }

  if (data.client_id && data.client_secret) {
    sessions.delete(options.sessionKey)
    return {
      status: 'success',
      appId: data.client_id,
      appSecret: data.client_secret,
      domain: session.domain,
      openId: data.user_info?.open_id,
    }
  }

  switch (data.error) {
    case undefined:
    case '':
    case 'authorization_pending':
      return {
        status: 'waiting',
        intervalSeconds: session.intervalSeconds,
        message: '等待飞书扫码确认...',
      }
    case 'slow_down':
      // The server asks for a longer gap; honour it for the rest of this run.
      session.intervalSeconds += 5
      return {
        status: 'waiting',
        intervalSeconds: session.intervalSeconds,
        message: '等待飞书扫码确认...',
      }
    case 'expired_token':
      sessions.delete(options.sessionKey)
      return { status: 'expired', message: '二维码已过期，请重新生成。' }
    case 'access_denied':
      sessions.delete(options.sessionKey)
      return { status: 'denied', message: '飞书授权被拒绝。' }
    default:
      sessions.delete(options.sessionKey)
      // The description can echo server-side detail; keep it out of the API
      // surface and log nothing that could carry a credential.
      return { status: 'failed', message: '飞书扫码授权失败，请重试。' }
  }
}

export function cancelFeishuRegistration(sessionKey: string): void {
  sessions.delete(sessionKey)
}

/** Test seam: the module-level session map must not leak across test cases. */
export function resetFeishuRegistrationsForTest(): void {
  sessions.clear()
}
