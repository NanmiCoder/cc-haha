import { bytesToBase64 } from './base64'
import { connectionHeaders, hostOrigin } from './connection'
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
  /** The body as base64, when it already arrived that way (the direct path): no decode and re-encode. */
  base64?(): Promise<string>
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
    credentials: FetchCredentials
  }
) => Promise<FetchResponse>
/**
 * `omit` everywhere except the H5 page the computer serves itself: there a
 * remote browser is authenticated by its device cookie, which only a
 * same-origin request carries.
 */
export type FetchCredentials = 'omit' | 'same-origin'
export type ApiClientOptions = {
  fetch?: FetchAdapter
  credentials?: FetchCredentials
  /** Until the computer answers (response headers). */
  timeoutMs?: number
  /** Reading the body once the computer has answered. */
  bodyTimeoutMs?: number
  /**
   * Told how each request ended: `null` on success, otherwise the error it
   * throws. Lets one place notice a computer whose address went away; it never
   * changes the request's own result.
   */
  onSettled?: (error: ApiError | null) => void
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
  #credentials: FetchCredentials
  #onSettled?: (error: ApiError | null) => void
  constructor(host: Host, credential: string, options: ApiClientOptions = {}) {
    this.host = Object.freeze({
      ...host,
      url: hostOrigin(host),
    })
    this.#credential = credential
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#timeoutMs = options.timeoutMs ?? 15000
    this.#bodyTimeoutMs = options.bodyTimeoutMs ?? BODY_TIMEOUT_MS
    this.#credentials = options.credentials ?? 'omit'
    this.#onSettled = options.onSettled
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
          'The server returned invalid data',
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
      return Promise.reject(new ApiError('Invalid image URL', 0, 'INVALID_PATH'))
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
      if (!response.arrayBuffer && !response.base64)
        throw new ApiError('The current network component cannot read images', 0, 'UNSUPPORTED')
      const type = response.headers?.get('Content-Type')?.split(';')[0]?.trim()
      if (!type?.startsWith('image/') || type === 'image/svg+xml')
        throw new ApiError('The server returned an invalid image', response.status, 'INVALID_RESPONSE')
      const encoded = response.base64
        ? await response.base64()
        : bytesToBase64(new Uint8Array(await response.arrayBuffer!()))
      return `data:${type};base64,${encoded}`
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
      throw new ApiError('Invalid request path', 0, 'INVALID_PATH')
    const url = new URL(path, this.host.url)
    if (url.origin !== this.host.url)
      throw new ApiError('Cross-host requests are not allowed', 0, 'CROSS_ORIGIN')
    if (options.body !== undefined && options.rawBody !== undefined)
      throw new ApiError('A request cannot contain both JSON and binary data', 0, 'INVALID_BODY')
    const controller = new AbortController()
    let timedOut: 'headers' | 'body' | null = null
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new ApiError('Invalid request timeout config', 0, 'INVALID_TIMEOUT')
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
        throw new ApiError('Request canceled', 0, 'ABORTED')
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
        credentials: this.#credentials,
      })
      // Defense in depth for injected adapters. Never consume data from redirected responses.
      if (
        response.redirected ||
        (response.url && new URL(response.url).origin !== this.host.url) ||
        (response.status >= 300 && response.status < 400)
      )
        throw new ApiError(
          'Server redirect was rejected',
          response.status,
          'REDIRECT_BLOCKED'
        )
      // The computer answered; from here a slow link only needs more time.
      clearTimeout(timer)
      timer = setTimeout(expire('body'), Math.max(timeoutMs, this.#bodyTimeoutMs))
      const value = await read(response)
      this.#settled(null)
      return value
    } catch (error) {
      const failure =
        timedOut === 'headers'
          ? new ApiError('Connection timed out; check whether the computer is online', 0, 'TIMEOUT')
          : timedOut === 'body'
            ? new ApiError('Network too slow, content could not finish transferring; please retry later', 0, 'TIMEOUT')
            : options.signal?.aborted
              ? new ApiError('Request canceled', 0, 'ABORTED')
              : error instanceof ApiError
                ? error
                : new ApiError('Cannot connect to the server; check the address and network', 0, 'NETWORK_ERROR')
      this.#settled(failure)
      throw failure
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }
  #settled(error: ApiError | null) {
    try {
      this.#onSettled?.(error)
    } catch {
      /* An observer never changes the request's result. */
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
    // An H5 page opened on the computer itself is trusted by its loopback
    // address and has no token to verify; any authenticated read proves it.
    if (this.host.auth === 'lan' && !this.#credential)
      return this.get<unknown>('/api/status', options).then(() => ({ ok: true as const }))
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
      throw new ApiError('This computer needs to be paired again', 401, 'PAIRING_REQUIRED')
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
        new ApiError('Pairing is only used for remote connections', 0, 'INVALID_AUTH')
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
        : `Request failed (${status})`,
    status,
    // The server puts the machine code in error (e.g. HISTORY_CHANGED); keep it even without a code field, 
    // otherwise callers can only guess from the message text.
    typeof data.code === 'string'
      ? data.code
      : typeof data.error === 'string'
        ? data.error
        : undefined
  )
}

export { bytesToBase64 }
