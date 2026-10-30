import { connectionHeaders, normalizeHostUrl } from './connection'
import type {
  CreateSessionInput,
  HistoryPage,
  Host,
  PairClaim,
  PairRequest,
  Session,
} from './types'

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  rawBody?: Uint8Array
  contentType?: string
  signal?: AbortSignal
  timeoutMs?: number
}
type RequestControlOptions = Pick<RequestOptions, 'signal' | 'timeoutMs'>
export type FetchResponse = {
  ok: boolean
  status: number
  url: string
  redirected: boolean
  text(): Promise<string>
  /** Binary bodies (tool images). Expo's fetch and the web fetch provide both. */
  arrayBuffer?(): Promise<ArrayBuffer>
  headers?: { get(name: string): string | null }
}
export type FetchAdapter = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string | ArrayBuffer
    signal: AbortSignal
    redirect: 'error'
    credentials: 'omit'
  }
) => Promise<FetchResponse>
export type ApiClientOptions = {
  fetch?: FetchAdapter
  /** Until the computer answers (response headers). */
  timeoutMs?: number
  /** Reading the body once the computer has answered. */
  bodyTimeoutMs?: number
}
/**
 * Once headers arrive the computer is clearly online; a large body over a slow
 * tunnel needs longer than the 15 s "is the computer there" budget.
 */
const BODY_TIMEOUT_MS = 60_000
export type ToolImageVariant = 'thumb' | 'full'
const TOOL_IMAGE_PATH = /^\/api\/sessions\/[^/?#]+\/tool-images\/[^/?#]+\/\d+$/

/** Native callers must inject expo/fetch, whose iOS/Android transports honor redirect:'error'. */
export class ApiClient {
  readonly host: Host
  #credential: string
  #fetch: FetchAdapter
  #timeoutMs: number
  #bodyTimeoutMs: number
  constructor(host: Host, credential: string, options: ApiClientOptions = {}) {
    this.host = Object.freeze({
      ...host,
      url: normalizeHostUrl(host.url, host.auth),
    })
    this.#credential = credential
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#timeoutMs = options.timeoutMs ?? 15000
    this.#bodyTimeoutMs = options.bodyTimeoutMs ?? BODY_TIMEOUT_MS
    connectionHeaders(this.host, credential)
    Object.freeze(this)
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.#send(path, options, 'application/json', async (response) => {
      const raw = await response.text()
      let value: unknown
      try {
        value = raw ? JSON.parse(raw) : undefined
      } catch {
        throw new ApiError(
          '服务器返回了无效数据',
          response.status,
          'INVALID_RESPONSE'
        )
      }
      if (!response.ok) throw failure(response.status, value)
      return value as T
    })
  }

  /** A referenced tool image as a data URI, ready for <Image source={{ uri }} />. */
  image(
    path: string,
    variant: ToolImageVariant,
    options?: RequestControlOptions
  ): Promise<string> {
    if (!TOOL_IMAGE_PATH.test(path))
      return Promise.reject(new ApiError('图片地址无效', 0, 'INVALID_PATH'))
    return this.#send(`${path}?variant=${variant}`, options ?? {}, 'image/*', async (response) => {
      if (!response.ok) {
        let value: unknown
        try {
          value = JSON.parse(await response.text())
        } catch {
          /* Not a JSON error body. */
        }
        throw failure(response.status, value)
      }
      if (!response.arrayBuffer)
        throw new ApiError('当前网络组件无法读取图片', 0, 'UNSUPPORTED')
      const type = response.headers?.get('Content-Type')?.split(';')[0]?.trim()
      if (!type?.startsWith('image/') || type === 'image/svg+xml')
        throw new ApiError('服务器返回了无效图片', response.status, 'INVALID_RESPONSE')
      return `data:${type};base64,${bytesToBase64(new Uint8Array(await response.arrayBuffer()))}`
    })
  }

  async #send<T>(
    path: string,
    options: RequestOptions,
    accept: string,
    read: (response: FetchResponse) => Promise<T>
  ): Promise<T> {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      path.includes('#')
    )
      throw new ApiError('请求路径无效', 0, 'INVALID_PATH')
    const url = new URL(path, this.host.url)
    if (url.origin !== this.host.url)
      throw new ApiError('禁止跨主机请求', 0, 'CROSS_ORIGIN')
    if (options.body !== undefined && options.rawBody !== undefined)
      throw new ApiError('请求不能同时包含 JSON 和二进制数据', 0, 'INVALID_BODY')
    const controller = new AbortController()
    let timedOut: 'headers' | 'body' | null = null
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new ApiError('请求超时配置无效', 0, 'INVALID_TIMEOUT')
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    const expire = (phase: 'headers' | 'body') => () => {
      timedOut = phase
      controller.abort()
    }
    let timer = setTimeout(expire('headers'), timeoutMs)
    try {
      if (controller.signal.aborted)
        throw new ApiError('请求已取消', 0, 'ABORTED')
      const response = await this.#fetch(url.toString(), {
        method: options.method ?? 'GET',
        headers: {
          Accept: accept,
          ...connectionHeaders(this.host, this.#credential),
          ...(options.rawBody !== undefined
            ? { 'Content-Type': options.contentType ?? 'application/octet-stream' }
            : options.body !== undefined
              ? { 'Content-Type': 'application/json' }
              : {}),
        },
        body:
          options.rawBody !== undefined
            // Copy just this view, including its byte offset and length. An
            // ArrayBuffer is supported by Expo's iOS/Android fetch transport.
            ? new Uint8Array(options.rawBody).buffer
            : options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      })
      // Defense in depth for injected adapters. Never consume data from redirected responses.
      if (
        response.redirected ||
        (response.url && new URL(response.url).origin !== this.host.url) ||
        (response.status >= 300 && response.status < 400)
      )
        throw new ApiError(
          '服务器重定向已被拒绝',
          response.status,
          'REDIRECT_BLOCKED'
        )
      // The computer answered; from here a slow link only needs more time.
      clearTimeout(timer)
      timer = setTimeout(expire('body'), Math.max(timeoutMs, this.#bodyTimeoutMs))
      return await read(response)
    } catch (error) {
      if (timedOut === 'headers')
        throw new ApiError('连接超时，请检查电脑是否在线', 0, 'TIMEOUT')
      if (timedOut === 'body')
        throw new ApiError('网络太慢，内容没能及时传完，请稍后重试', 0, 'TIMEOUT')
      if (options.signal?.aborted)
        throw new ApiError('请求已取消', 0, 'ABORTED')
      if (error instanceof ApiError) throw error
      throw new ApiError('无法连接服务器，请检查地址与网络', 0, 'NETWORK_ERROR')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }
  get<T>(path: string, options?: RequestControlOptions) {
    return this.request<T>(path, options)
  }
  post<T>(
    path: string,
    body?: unknown,
    options?: RequestControlOptions
  ) {
    return this.request<T>(path, { ...options, method: 'POST', body })
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PUT', body })
  }
  patch<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PATCH', body })
  }
  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' })
  }
  async verify(
    options?: RequestControlOptions
  ): Promise<{ ok: true }> {
    if (this.host.auth === 'lan')
      return this.post<{ ok: true }>(
        '/api/h5-access/verify',
        undefined,
        options
      )
    const session = await this.get<{ authenticated: boolean }>(
      '/api/public-access/session',
      options
    )
    if (!session.authenticated)
      throw new ApiError('需要重新配对这台电脑', 401, 'PAIRING_REQUIRED')
    return { ok: true }
  }
  listSessions() {
    return this.get<{ sessions: Session[]; total: number }>('/api/sessions')
  }
  createSession(input: CreateSessionInput) {
    return this.post<{ sessionId: string; workDir?: string }>(
      '/api/sessions',
      input
    )
  }
  history(
    id: string,
    cursor?: string,
    options?: RequestControlOptions
  ) {
    // media=ref: tool images arrive as references and are downloaded only when shown.
    return this.get<HistoryPage>(
      `/api/sessions/${encodeURIComponent(id)}/messages?media=ref${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      options
    )
  }
  pair(secret: string, name: string) {
    if (this.host.auth !== 'remote')
      return Promise.reject(
        new ApiError('仅远程连接使用配对流程', 0, 'INVALID_AUTH')
      )
    return this.post<PairRequest>('/api/public-access/pair', {
      secret,
      name,
      clientType: 'native',
    })
  }
  claimPair(id: string, claimSecret: string) {
    return this.post<PairClaim>('/api/public-access/claim', { id, claimSecret })
  }
}

function failure(status: number, value: unknown): ApiError {
  const data =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return new ApiError(
    typeof data.message === 'string'
      ? data.message
      : typeof data.error === 'string'
        ? data.error
        : `请求失败 (${status})`,
    status,
    // 服务端把机器码放在 error 里（如 HISTORY_CHANGED）；没有 code 字段时也要保留，
    // 否则调用方只能按提示文案猜。
    typeof data.code === 'string'
      ? data.code
      : typeof data.error === 'string'
        ? data.error
        : undefined
  )
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Hermes has no Buffer. Slices are multiples of 3 bytes, so only the last one pads. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let start = 0; start < bytes.length; start += 3 * 4096) {
    const end = Math.min(bytes.length, start + 3 * 4096)
    let out = ''
    for (let i = start; i < end; i += 3) {
      const a = bytes[i]!
      const b = i + 1 < end ? bytes[i + 1]! : 0
      const c = i + 2 < end ? bytes[i + 2]! : 0
      out +=
        BASE64[a >> 2] +
        BASE64[((a & 3) << 4) | (b >> 4)] +
        (i + 1 < end ? BASE64[((b & 15) << 2) | (c >> 6)] : '=') +
        (i + 2 < end ? BASE64[c & 63] : '=')
    }
    parts.push(out)
  }
  return parts.join('')
}
