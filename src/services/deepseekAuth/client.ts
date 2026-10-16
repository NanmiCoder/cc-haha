/**
 * DeepSeek platform account login (the "DSH" browser PKCE flow).
 *
 * Wire protocol, as implemented by DeepSeek Harness' platform provider:
 *   POST {platform}/auth-api/v0/dsh/auth_init      PKCE challenge + loopback redirect_uri
 *   browser -> authorize_url (path /dsh/authorize), then redirected to redirect_uri?code&state
 *   POST {platform}/auth-api/v0/dsh/auth_exchange  code + verifier -> opaque account token
 *   POST {platform}/auth-api/v0/dsh/auth_cancel    revoke an unexchanged attempt
 *   POST {platform}/auth-api/v0/users/logout       end the session
 * Every response is `{ code: 0, data: { biz_code: 0, biz_data } }`; a rejected
 * token is HTTP 401 or `{ code: 40003 }`. The token has no refresh flow and is
 * sent to the inference endpoint as `x-dsh-auth-token` (no Bearer prefix).
 */
import { arch, platform, release } from 'os'
import { z } from 'zod'
import type {
  DeepSeekAuthExchange,
  DeepSeekAuthInit,
  DeepSeekClientIdentity,
} from './types.js'

export const DEEPSEEK_PLATFORM_ORIGIN = 'https://platform.deepseek.com'
export const DEEPSEEK_INFERENCE_ORIGIN = 'https://api.deepseek.com'
export const DEEPSEEK_ANTHROPIC_BASE_URL = `${DEEPSEEK_INFERENCE_ORIGIN}/anthropic`
export const DEEPSEEK_PLATFORM_ORIGIN_ENV_KEY = 'CC_HAHA_DEEPSEEK_PLATFORM_ORIGIN'
export const DEEPSEEK_AUTH_HEADER = 'x-dsh-auth-token'
export const DEEPSEEK_OAUTH_DUMMY_KEY = 'deepseek-oauth-dummy-key'
export const DEEPSEEK_CALLBACK_PATH = '/oauth/callback'
// The platform reads the five x-client-* headers on login. This is the
// DeepSeek Harness release the protocol was taken from; bump it with the
// protocol, like GROK_CLI_VERSION.
export const DEEPSEEK_CLIENT_VERSION = '0.2.1-alpha.2'

const AUTHORIZE_PATH = '/dsh/authorize'
const AUTHORIZED_PATH = '/dsh/authorized'
const RESPONSE_BODY_LIMIT = 65_536
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * A redirect would replay `x-dsh-auth-token` to another origin (fetch strips
 * only `Authorization` across origins), so account requests refuse redirects.
 */
export function deepSeekAccountFetchInit(
  headers: Record<string, string>,
): { redirect?: 'error' } {
  return Object.keys(headers).some(
    (name) => name.toLowerCase() === DEEPSEEK_AUTH_HEADER,
  )
    ? { redirect: 'error' }
    : {}
}

export type DeepSeekAuthErrorCode =
  | 'no-response'
  | 'network'
  | 'protocol'
  | 'unauthorized'

/** Carries a stable code only; response bodies and URLs never enter the message. */
export class DeepSeekAuthError extends Error {
  constructor(readonly code: DeepSeekAuthErrorCode) {
    super(`DeepSeek account: ${code}`)
    this.name = 'DeepSeekAuthError'
  }
}

export type DeepSeekRequestOptions = {
  fetchOverride?: typeof fetch
  proxyUrl?: string | null
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Platform origin: production unless a test or private deployment overrides
 * it. Only HTTPS or loopback HTTP origins are accepted; anything else falls
 * back to production so a stray variable cannot redirect credentials.
 */
export function getDeepSeekPlatformOrigin(): string {
  const override = process.env[DEEPSEEK_PLATFORM_ORIGIN_ENV_KEY]?.trim()
  if (!override) return DEEPSEEK_PLATFORM_ORIGIN
  try {
    const url = new URL(override)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const acceptable =
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' || (loopback && url.protocol === 'http:'))
    return acceptable ? url.origin : DEEPSEEK_PLATFORM_ORIGIN
  } catch {
    return DEEPSEEK_PLATFORM_ORIGIN
  }
}

/** `zh_CN` for any Chinese UI language, otherwise `en_US`, as the platform expects. */
export function normalizeDeepSeekLocale(locale: string | undefined): 'zh_CN' | 'en_US' {
  return (locale ?? '').toLowerCase().split(/[-_]/)[0] === 'zh' ? 'zh_CN' : 'en_US'
}

export function resolveDeepSeekClientIdentity(
  locale?: string,
): DeepSeekClientIdentity {
  return {
    version: DEEPSEEK_CLIENT_VERSION,
    locale: normalizeDeepSeekLocale(
      locale ?? Intl.DateTimeFormat().resolvedOptions().locale,
    ),
    // East of UTC is positive, the opposite of Date#getTimezoneOffset.
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

export function buildDeepSeekClientHeaders(
  identity: DeepSeekClientIdentity,
  nodePlatform: string = process.platform,
): Record<string, string> {
  const clientPlatform =
    nodePlatform === 'darwin'
      ? 'desktop-mac'
      : nodePlatform === 'win32'
        ? 'desktop-win'
        : 'web'
  return {
    'x-client-bundle-id': '',
    'x-client-platform': clientPlatform,
    'x-client-version': identity.version,
    'x-client-locale': normalizeDeepSeekLocale(identity.locale),
    'x-client-timezone-offset': String(identity.timezoneOffsetSeconds),
  }
}

export function getDeepSeekDeviceDescription(): {
  deviceModel: string
  osVersion: string
} {
  return {
    deviceModel: `${platform()}-${arch()}`,
    osVersion: `${platform()} ${release()}`,
  }
}

/**
 * The authorize and completion pages must live on the platform origin at a
 * fixed path; the server's answer never gets to choose where the browser goes.
 */
export function validateDeepSeekBrowserUrl(
  value: string,
  origin: string,
  expectedPath: typeof AUTHORIZE_PATH | typeof AUTHORIZED_PATH,
): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new DeepSeekAuthError('protocol')
  }
  if (
    url.origin !== origin ||
    url.pathname !== expectedPath ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new DeepSeekAuthError('protocol')
  }
  return url.href
}

const envelopeSchema = z.object({
  code: z.literal(0),
  data: z.object({ biz_code: z.number().int(), biz_data: z.unknown() }),
})
const initSchema = z.object({
  authorize_url: z.string().url(),
  authorize_id: z.string().min(1),
  expires_in: z.number().positive(),
})
const exchangeSchema = z.object({
  token: z.string().regex(/^[\x21-\x7e]+$/),
  authorized_url: z.string().url(),
  user: z.unknown().optional(),
})
const userSchema = z.object({
  email: z.string().optional(),
  mobile: z.string().optional(),
  mobile_number: z.string().optional(),
  id_profile: z
    .object({ name: z.string().nullable().optional() })
    .nullish(),
})

export function projectDeepSeekUser(value: unknown): {
  name: string | null
  contact: string | null
} {
  const parsed = userSchema.safeParse(value)
  if (!parsed.success) return { name: null, contact: null }
  const { email, mobile, mobile_number: mobileNumber, id_profile: profile } =
    parsed.data
  return {
    name: profile?.name || null,
    contact: mobile || mobileNumber || email || null,
  }
}

export async function initDeepSeekAuth(
  input: {
    codeChallenge: string
    state: string
    redirectUri: string
    identity: DeepSeekClientIdentity
  } & DeepSeekRequestOptions,
): Promise<DeepSeekAuthInit> {
  const origin = getDeepSeekPlatformOrigin()
  const payload = await postPlatform(
    `${origin}/auth-api/v0/dsh/auth_init`,
    {
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      state: input.state,
      redirect_uri: input.redirectUri,
      locale: normalizeDeepSeekLocale(input.identity.locale),
      // "web": the platform's desktop flavour hands the browser back to a
      // dsh:// deep link, which does not exist for this application.
      login_source: 'web',
    },
    buildDeepSeekClientHeaders(input.identity),
    input,
  )
  const parsed = initSchema.safeParse(payload)
  if (!parsed.success) throw new DeepSeekAuthError('protocol')
  return {
    authorizeUrl: validateDeepSeekBrowserUrl(
      parsed.data.authorize_url,
      origin,
      AUTHORIZE_PATH,
    ),
    authorizeId: parsed.data.authorize_id,
    expiresInSeconds: parsed.data.expires_in,
  }
}

export async function exchangeDeepSeekCode(
  input: {
    code: string
    codeVerifier: string
    redirectUri: string
    deviceId: string
    identity: DeepSeekClientIdentity
  } & DeepSeekRequestOptions,
): Promise<DeepSeekAuthExchange> {
  const origin = getDeepSeekPlatformOrigin()
  const device = getDeepSeekDeviceDescription()
  const payload = await postPlatform(
    `${origin}/auth-api/v0/dsh/auth_exchange`,
    {
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      device_id: input.deviceId,
      device_model: device.deviceModel,
      os_version: device.osVersion,
    },
    buildDeepSeekClientHeaders(input.identity),
    input,
  )
  const parsed = exchangeSchema.safeParse(payload)
  if (!parsed.success) throw new DeepSeekAuthError('protocol')
  const completion = new URL(
    validateDeepSeekBrowserUrl(parsed.data.authorized_url, origin, AUTHORIZED_PATH),
  )
  completion.searchParams.set('login_source', 'web')
  return {
    token: parsed.data.token,
    authorizedUrl: completion.href,
    ...projectDeepSeekUser(parsed.data.user),
  }
}

/** Best effort: invalidates an authorize_id whose code was never exchanged. */
export async function cancelDeepSeekAuth(
  input: {
    authorizeId: string
    codeVerifier: string
    identity: DeepSeekClientIdentity
  } & DeepSeekRequestOptions,
): Promise<void> {
  await postPlatform(
    `${getDeepSeekPlatformOrigin()}/auth-api/v0/dsh/auth_cancel`,
    { authorize_id: input.authorizeId, code_verifier: input.codeVerifier },
    buildDeepSeekClientHeaders(input.identity),
    input,
  )
}

export async function logoutDeepSeekAccount(
  token: string,
  input: { identity: DeepSeekClientIdentity } & DeepSeekRequestOptions,
): Promise<void> {
  await requestPlatform(
    `${getDeepSeekPlatformOrigin()}/auth-api/v0/users/logout`,
    {
      method: 'POST',
      headers: {
        ...buildDeepSeekClientHeaders(input.identity),
        [DEEPSEEK_AUTH_HEADER]: token,
      },
    },
    input,
  )
}

export async function fetchDeepSeekProfile(
  token: string,
  input: { identity: DeepSeekClientIdentity } & DeepSeekRequestOptions,
): Promise<{ name: string | null; contact: string | null }> {
  const payload = await requestPlatform(
    `${getDeepSeekPlatformOrigin()}/auth-api/v0/users/current`,
    {
      method: 'GET',
      headers: {
        ...buildDeepSeekClientHeaders(input.identity),
        [DEEPSEEK_AUTH_HEADER]: token,
      },
    },
    input,
  )
  return projectDeepSeekUser(payload)
}

function postPlatform(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: DeepSeekRequestOptions,
): Promise<unknown> {
  return requestPlatform(
    url,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    options,
  )
}

async function requestPlatform(
  url: string,
  init: RequestInit,
  options: DeepSeekRequestOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchOverride ?? globalThis.fetch
  const authenticated = new Headers(init.headers).has(DEEPSEEK_AUTH_HEADER)
  const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)]
  if (options.signal) signals.push(options.signal)
  let response: Response
  try {
    response = await fetchImpl(url, {
      ...init,
      // A redirect would replay the account token to another origin.
      redirect: 'error',
      signal: AbortSignal.any(signals),
      ...(await resolveProxyFetchOptions(options.proxyUrl)),
    })
  } catch {
    throw new DeepSeekAuthError('no-response')
  }
  if (response.status === 401 && authenticated) {
    await response.body?.cancel().catch(() => undefined)
    throw new DeepSeekAuthError('unauthorized')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new DeepSeekAuthError('network')
  }
  const text = await readBoundedText(response)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new DeepSeekAuthError('protocol')
  }
  if (
    authenticated &&
    z.object({ code: z.literal(40003) }).safeParse(payload).success
  ) {
    throw new DeepSeekAuthError('unauthorized')
  }
  const envelope = envelopeSchema.safeParse(payload)
  if (!envelope.success || envelope.data.data.biz_code !== 0) {
    throw new DeepSeekAuthError('protocol')
  }
  return envelope.data.data.biz_data
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) throw new DeepSeekAuthError('network')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > RESPONSE_BODY_LIMIT) throw new DeepSeekAuthError('protocol')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Fetch options for the app's network proxy; `undefined` leaves the process default. */
export async function resolveProxyFetchOptions(
  proxyUrl: string | null | undefined,
): Promise<RequestInit> {
  if (proxyUrl === undefined) return {}
  const { getProxyFetchOptions } = await import('../../utils/proxy.js')
  return getProxyFetchOptions({ proxyUrl })
}
