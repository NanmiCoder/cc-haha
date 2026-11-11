import crypto from 'node:crypto'
import { fetchWechatMediaResource } from './media-network.js'

export const WECHAT_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WECHAT_DEFAULT_BOT_TYPE = '3'

const ILINK_APP_ID = 'bot'
const CHANNEL_VERSION = '2.1.7'
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION)
const QR_LOGIN_TTL_MS = 5 * 60_000
const QR_STATUS_TIMEOUT_MS = 35_000
const GET_UPDATES_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000

type QrLoginStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'

type ActiveLogin = {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  startedAt: number
  currentApiBaseUrl: string
}

type QrCodeResponse = {
  qrcode: string
  qrcode_img_content: string
}

type QrStatusResponse = {
  status: QrLoginStatus
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

export type WechatQrStartResult = {
  qrcodeUrl?: string
  message: string
  sessionKey: string
}

export type WechatQrPollResult = {
  connected: boolean
  status: QrLoginStatus | 'not_started'
  message: string
  botToken?: string
  accountId?: string
  baseUrl?: string
  userId?: string
}

export type WechatMessageItem = {
  type?: number
  msg_id?: string
  text_item?: { text?: string }
  voice_item?: { text?: string }
  media?: WechatCdnMedia
  image_item?: {
    media?: WechatCdnMedia
    thumb_media?: WechatCdnMedia
    aeskey?: string
    url?: string
  }
  file_item?: {
    media?: WechatCdnMedia
    file_name?: string
    len?: string
  }
  video_item?: {
    media?: WechatCdnMedia
    thumb_media?: WechatCdnMedia
    video_size?: number
  }
  ref_msg?: {
    title?: string
    message_item?: WechatMessageItem
  }
}

export type WechatCdnMedia = {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
  encrypt_type?: number
}

/** Bounded, authenticated media API calls. Errors deliberately omit response bodies. */
export async function requestWechatMediaApi(params: {
  baseUrl: string
  token: string
  endpoint: 'getuploadurl' | 'sendmessage'
  payload: Record<string, unknown>
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ ...params.payload, base_info: buildBaseInfo() })
  const response = await fetchWechatMediaResource({
    url: new URL(`ilink/bot/${params.endpoint}`, ensureTrailingSlash(params.baseUrl)).toString(),
    service: 'api',
    init: { method: 'POST', headers: buildHeaders({ token: params.token, body }), body },
    maxBytes: 64 * 1024,
    timeoutMs: params.timeoutMs ?? API_TIMEOUT_MS,
    signal: params.signal,
  })
  let parsed: unknown
  try { parsed = JSON.parse(response.bytes.toString('utf8')) } catch {
    throw new Error(`WeChat ${params.endpoint} returned invalid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`WeChat ${params.endpoint} returned invalid response`)
  }
  const record = parsed as Record<string, unknown>
  for (const key of ['ret', 'errcode']) {
    if (record[key] !== undefined && (typeof record[key] !== 'number' || record[key] !== 0)) {
      const code = typeof record[key] === 'number' ? record[key] : 'invalid'
      throw new Error(`WeChat ${params.endpoint} returned ${code}`)
    }
  }
  return record
}

export type WechatMessage = {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  message_type?: number
  message_state?: number
  item_list?: WechatMessageItem[]
  context_token?: string
}

export type WechatGetUpdatesResp = {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WechatMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

const activeLogins = new Map<string, ActiveLogin>()

export function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

export function extractWechatText(itemList?: WechatMessageItem[]): string {
  if (!itemList?.length) return ''
  for (const item of itemList) {
    if (item.type === 1 && item.text_item?.text != null) {
      const text = String(item.text_item.text)
      const ref = item.ref_msg
      if (!ref) return text
      const parts: string[] = []
      if (ref.title) parts.push(ref.title)
      if (ref.message_item) {
        const refBody = extractWechatText([ref.message_item])
        if (refBody) parts.push(refBody)
      }
      return parts.length ? `[引用: ${parts.join(' | ')}]\n${text}` : text
    }
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text
    }
  }
  return ''
}

export async function startWechatLoginWithQr(opts: {
  force?: boolean
  sessionKey?: string
  botType?: string
} = {}): Promise<WechatQrStartResult> {
  purgeExpiredLogins()

  const sessionKey = opts.sessionKey || crypto.randomUUID()
  const existing = activeLogins.get(sessionKey)
  if (!opts.force && existing && isLoginFresh(existing)) {
    return {
      qrcodeUrl: existing.qrcodeUrl,
      message: '二维码已就绪，请使用微信扫描。',
      sessionKey,
    }
  }

  const botType = opts.botType || WECHAT_DEFAULT_BOT_TYPE
  const rawText = await apiGetFetch({
    baseUrl: WECHAT_DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: 'wechatQrStart',
  })
  const qr = JSON.parse(rawText) as QrCodeResponse
  if (!qr.qrcode || !qr.qrcode_img_content) {
    throw new Error('WeChat QR response did not include a QR code URL')
  }

  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: Date.now(),
    currentApiBaseUrl: WECHAT_DEFAULT_BASE_URL,
  })

  return {
    qrcodeUrl: qr.qrcode_img_content,
    message: '使用微信扫描二维码完成绑定。',
    sessionKey,
  }
}

export async function pollWechatLoginWithQr(opts: {
  sessionKey: string
}): Promise<WechatQrPollResult> {
  purgeExpiredLogins()

  const login = activeLogins.get(opts.sessionKey)
  if (!login) {
    return {
      connected: false,
      status: 'not_started',
      message: '当前没有进行中的微信绑定，请重新生成二维码。',
    }
  }

  const status = await pollQrStatus(login.currentApiBaseUrl, login.qrcode)
  switch (status.status) {
    case 'wait':
      return { connected: false, status: 'wait', message: '等待扫码。' }
    case 'scaned':
      return { connected: false, status: 'scaned', message: '已扫码，请在微信中确认。' }
    case 'scaned_but_redirect':
      if (status.redirect_host) {
        login.currentApiBaseUrl = `https://${status.redirect_host}`
      }
      return { connected: false, status: 'scaned_but_redirect', message: '已扫码，正在切换微信网关。' }
    case 'expired':
      activeLogins.delete(opts.sessionKey)
      return { connected: false, status: 'expired', message: '二维码已过期，请重新生成。' }
    case 'confirmed':
      activeLogins.delete(opts.sessionKey)
      if (!status.bot_token || !status.ilink_bot_id) {
        return { connected: false, status: 'confirmed', message: '微信已确认，但服务端未返回完整凭据。' }
      }
      return {
        connected: true,
        status: 'confirmed',
        message: '微信绑定成功。',
        botToken: status.bot_token,
        accountId: status.ilink_bot_id,
        baseUrl: status.baseurl || login.currentApiBaseUrl || WECHAT_DEFAULT_BASE_URL,
        userId: status.ilink_user_id,
      }
  }
}

export async function getWechatUpdates(params: {
  baseUrl: string
  token: string
  getUpdatesBuf?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<WechatGetUpdatesResp> {
  const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: params.getUpdatesBuf ?? '',
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: params.timeoutMs ?? GET_UPDATES_TIMEOUT_MS,
      label: 'wechatGetUpdates',
      signal: params.signal,
    })
  const response = JSON.parse(rawText)
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('wechatGetUpdates invalid response')
  if (response.msgs !== undefined && !Array.isArray(response.msgs)) throw new Error('wechatGetUpdates invalid messages')
  if (response.get_updates_buf !== undefined && typeof response.get_updates_buf !== 'string') throw new Error('wechatGetUpdates invalid cursor')
  for (const key of ['ret', 'errcode']) {
    if (response[key] !== undefined && typeof response[key] !== 'number') throw new Error('wechatGetUpdates invalid status')
  }
  return response as WechatGetUpdatesResp
}

export async function sendWechatText(params: {
  baseUrl: string
  token: string
  to: string
  text: string
  contextToken?: string
  timeoutMs?: number
  clientId?: string
}): Promise<void> {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: params.to,
      client_id: params.clientId ?? `claude-code-haha-wechat-${crypto.randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: params.text ? [{ type: 1, text_item: { text: params.text } }] : undefined,
      context_token: params.contextToken,
    },
    base_info: buildBaseInfo(),
  }

  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify(body),
    token: params.token,
    timeoutMs: params.timeoutMs ?? API_TIMEOUT_MS,
    label: 'wechatSendMessage',
  })
  assertWechatApiOk(rawText, 'wechatSendMessage')
}

export async function getWechatConfig(params: {
  baseUrl: string
  token: string
  ilinkUserId: string
  contextToken?: string
  timeoutMs?: number
}): Promise<{ ret?: number; errmsg?: string; typing_ticket?: string }> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
    label: 'wechatGetConfig',
  })
  return JSON.parse(rawText) as { ret?: number; errmsg?: string; typing_ticket?: string }
}

export async function sendWechatTyping(params: {
  baseUrl: string
  token: string
  ilinkUserId: string
  typingTicket: string
  status: 'typing' | 'cancel'
  timeoutMs?: number
}): Promise<void> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status === 'typing' ? 1 : 2,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
    label: 'wechatSendTyping',
  })
  assertWechatApiOk(rawText, 'wechatSendTyping')
}

async function pollQrStatus(apiBaseUrl: string, qrcode: string): Promise<QrStatusResponse> {
  try {
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_STATUS_TIMEOUT_MS,
      label: 'wechatQrStatus',
    })
    return JSON.parse(rawText) as QrStatusResponse
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { status: 'wait' }
    return { status: 'wait' }
  }
}

async function apiGetFetch(params: {
  baseUrl: string
  endpoint: string
  timeoutMs?: number
  label: string
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl))
  const controller = params.timeoutMs ? new AbortController() : undefined
  const timer = controller ? setTimeout(() => controller.abort(), params.timeoutMs) : undefined
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: buildCommonHeaders(),
      ...(controller ? { signal: controller.signal } : {}),
    })
    const rawText = await res.text()
    if (!res.ok) throw new Error(`${params.label} ${res.status}: ${rawText}`)
    return rawText
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function apiPostFetch(params: {
  baseUrl: string
  endpoint: string
  body: string
  token?: string
  timeoutMs: number
  label: string
  signal?: AbortSignal
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl))
  const controller = new AbortController()
  params.signal?.throwIfAborted()
  const abort = () => controller.abort()
  params.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders({ token: params.token, body: params.body }),
      body: params.body,
      signal: controller.signal,
    })
    const rawText = await res.text()
    if (!res.ok) throw new WechatApiError(`${params.label} HTTP ${res.status}`, res.status, undefined)
    return rawText
  } finally {
    clearTimeout(timer)
    params.signal?.removeEventListener('abort', abort)
  }
}

function buildBaseInfo(): { channel_version: string } {
  return { channel_version: CHANNEL_VERSION }
}

function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(opts.body, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  }
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`
  }
  return headers
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

export class WechatApiError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly apiCode?: number) {
    super(message)
    this.name = 'WechatApiError'
  }
}

/** Tencent's documented account-session pause code, distinct from network errors. */
export function isWechatAuthenticationError(error: unknown): boolean {
  return error instanceof WechatApiError && (error.httpStatus === 401 || error.apiCode === -14)
}

function assertWechatApiOk(rawText: string, label: string): void {

  let body: unknown
  try {
    body = JSON.parse(rawText)
  } catch {
    throw new Error(`${label} invalid response`)
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${label} invalid response`)

  const record = body as Record<string, unknown>
  for (const key of ['ret', 'errcode']) {
    if (record[key] !== undefined && typeof record[key] !== 'number') throw new Error(`${label} invalid response`)
    if (typeof record[key] === 'number' && record[key] !== 0) {
      throw new WechatApiError(`${label} returned ${record[key]}`, undefined, record[key])
    }
  }
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < QR_LOGIN_TTL_MS
}

function purgeExpiredLogins(): void {
  for (const [sessionKey, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(sessionKey)
  }
}
