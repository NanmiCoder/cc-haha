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
export type ApiClientOptions = { fetch?: FetchAdapter; timeoutMs?: number }

/** Native callers must inject expo/fetch, whose iOS/Android transports honor redirect:'error'. */
export class ApiClient {
  readonly host: Host
  #credential: string
  #fetch: FetchAdapter
  #timeoutMs: number
  constructor(host: Host, credential: string, options: ApiClientOptions = {}) {
    this.host = Object.freeze({
      ...host,
      url: normalizeHostUrl(host.url, host.auth),
    })
    this.#credential = credential
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#timeoutMs = options.timeoutMs ?? 15000
    connectionHeaders(this.host, credential)
    Object.freeze(this)
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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
    let timedOut = false
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new ApiError('请求超时配置无效', 0, 'INVALID_TIMEOUT')
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      if (controller.signal.aborted)
        throw new ApiError('请求已取消', 0, 'ABORTED')
      const response = await this.#fetch(url.toString(), {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
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
      if (!response.ok) {
        const data =
          value && typeof value === 'object'
            ? (value as Record<string, unknown>)
            : {}
        throw new ApiError(
          typeof data.message === 'string'
            ? data.message
            : typeof data.error === 'string'
              ? data.error
              : `请求失败 (${response.status})`,
          response.status,
          // 服务端把机器码放在 error 里（如 HISTORY_CHANGED）；没有 code 字段时也要保留，
          // 否则调用方只能按提示文案猜。
          typeof data.code === 'string'
            ? data.code
            : typeof data.error === 'string'
              ? data.error
              : undefined
        )
      }
      return value as T
    } catch (error) {
      if (timedOut)
        throw new ApiError('连接超时，请检查电脑是否在线', 0, 'TIMEOUT')
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
    return this.get<HistoryPage>(
      `/api/sessions/${encodeURIComponent(id)}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
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
