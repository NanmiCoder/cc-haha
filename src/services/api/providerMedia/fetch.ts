import { createHash } from 'node:crypto'
import { resolveProviderMediaEndpoint } from './providers.js'
import type { InlineImage, MediaEndpointResolver } from './types.js'

type CachedFile = { id: string; expiresAt: number }

/** Metadata only, bounded and credential-scoped. Original images stay in the transcript. */
export class MediaFileCache {
  private readonly files = new Map<string, CachedFile>()

  get(key: string, now: number): CachedFile | undefined {
    const file = this.files.get(key)
    if (!file) return undefined
    this.files.delete(key)
    if (file.expiresAt <= now) return undefined
    this.files.set(key, file)
    return file
  }

  set(key: string, file: CachedFile): void {
    this.files.delete(key)
    this.files.set(key, file)
    while (this.files.size > 1024) this.files.delete(this.files.keys().next().value!)
  }

  delete(key: string): void {
    this.files.delete(key)
  }
}

const sharedCache = new MediaFileCache()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function mergedHeaders(input: Request | null, init?: RequestInit): Headers {
  // Fetch treats init.headers as a replacement, not a merge with Request.
  return new Headers(init?.headers ?? input?.headers)
}

function appendBeta(headers: Headers, beta: string | undefined): void {
  if (!beta) return
  const values = new Set((headers.get('anthropic-beta') ?? '').split(',').map(v => v.trim()).filter(Boolean))
  values.add(beta)
  headers.set('anthropic-beta', [...values].join(','))
}

async function readRequestBody(request: Request, signal: AbortSignal | null | undefined): Promise<string> {
  signal?.throwIfAborted()
  const reader = request.clone().body?.getReader()
  if (!reader) return ''
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const decoder = new TextDecoder()
    let result = ''
    while (true) {
      const chunk = await reader.read()
      signal?.throwIfAborted()
      if (chunk.done) return result + decoder.decode()
      result += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

async function isMissingFile(response: Response, ids: string[], compressed: boolean): Promise<boolean> {
  if (![400, 404, 410].includes(response.status) || ids.length === 0) return false
  // Inspect a bounded clone; keep the original response available to the SDK.
  let stream = response.clone().body
  if (!stream) return false
  if (compressed) {
    const encoding = response.headers.get('content-encoding')
    if (encoding && ['gzip', 'deflate', 'zstd'].includes(encoding)) {
      stream = stream.pipeThrough(new DecompressionStream(encoding as CompressionFormat))
    }
  }
  const reader = stream.getReader()
  let text = ''
  try {
    const decoder = new TextDecoder()
    while (text.length < 8192) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value.subarray(0, 8192 - text.length))
    }
  } catch {
    return false
  } finally {
    void reader.cancel().catch(() => {})
  }
  return /file/i.test(text) && /expired|not[ _-]found|does not exist|invalid.*file/i.test(text) &&
    (ids.some(id => text.includes(id)) || /file[ _-](not[ _-]found|expired)/i.test(text))
}

/**
 * Runs at the final authenticated fetch seam, after protocol conversion.
 * Resolver injection is for offline tests/future providers, never URL overrides
 * from model output. Unknown endpoints pass through untouched.
 */
export function buildProviderMediaFetch(
  inner: typeof fetch,
  options: {
    resolveEndpoint?: MediaEndpointResolver
    cache?: MediaFileCache
    now?: () => number
  } = {},
): typeof fetch {
  const resolveEndpoint = options.resolveEndpoint ?? resolveProviderMediaEndpoint
  const cache = options.cache ?? sharedCache
  const now = options.now ?? Date.now

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url ?? String(input))
    const endpoint = resolveEndpoint(url)
    if (!endpoint || (init?.method ?? request?.method ?? 'GET').toUpperCase() !== 'POST') return inner(input, init)
    const headers = mergedHeaders(request, init)
    const credentials = endpoint.credentialScope(headers)
    if (!credentials) return inner(input, init)
    if (new URL(endpoint.uploadUrl).origin !== url.origin) return inner(input, init)

    // SDK/proxy requests use strings. A Request input is also supported without
    // consuming its body; non-JSON/binary requests remain the caller's concern.
    const signal = init?.signal ?? request?.signal
    const raw = typeof init?.body === 'string' ? init.body
      : init?.body == null && request ? await readRequestBody(request, signal) : undefined
    if (raw === undefined) return inner(input, init)
    let original: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return inner(input, init)
      original = parsed as Record<string, unknown>
    } catch {
      return inner(input, init)
    }
    const scope = hash(JSON.stringify([endpoint.providerId, url.origin, credentials]))
    const used = new Map<string, string>()
    let uploadFailed = false

    async function prepare(force: boolean, allowUploads = true): Promise<string> {
      // Reparse for retry: mutations affect only a disposable outbound copy.
      const body = JSON.parse(raw!) as Record<string, unknown>
      const images = endpoint!.collectImages(body)
      const groups = new Map<string, InlineImage[]>()
      for (const image of images) {
        const key = `${scope}:${hash(image.mediaType + ':' + image.data)}`
        const group = groups.get(key) ?? []
        group.push(image)
        groups.set(key, group)
      }
      let changed = false
      let bytes = Buffer.byteLength(raw!)
      const candidates: [string, InlineImage[]][] = []
      for (const [key, group] of groups) {
        const cached = cache.get(key, now())
        if (cached) {
          for (const image of group) bytes -= image.replace(cached.id)
          used.set(key, cached.id)
          changed = true
        } else candidates.push([key, group])
      }
      const shouldUpload = allowUploads && (force || bytes > endpoint!.triggerBytes)
      if (!shouldUpload) return changed ? JSON.stringify(body) : raw!
      // Largest first; stable ordering gives older images precedence on ties.
      candidates.sort((a, b) => b[1][0]!.data.length * b[1].length - a[1][0]!.data.length * a[1].length)
      const target = force ? Math.min(endpoint!.targetBytes, Math.floor(bytes * 0.75)) : endpoint!.targetBytes
      for (const [key, group] of candidates) {
        if (bytes <= target) break
        signal?.throwIfAborted()
        const image = group[0]!
        if (image.data.length > Math.ceil(endpoint!.maxFileBytes / 3) * 4) continue
        const buffer = Buffer.from(image.data, 'base64')
        if (!buffer.length || buffer.length > endpoint!.maxFileBytes || buffer.toString('base64') !== image.data) continue
        // Carry network/proxy/TLS options and cancellation through the same
        // transport. Uploads bypass this wrapper so they cannot recurse.
        try {
          const startedAt = now()
          const upload = endpoint!.createUpload(buffer, image.mediaType, headers)
          const uploadInit: RequestInit & { decompress: boolean } = {
            ...init,
            method: 'POST',
            ...upload,
            signal,
            redirect: 'error',
            // Anthropic passthrough keeps inference compressed for streaming.
            // The upload response is JSON consumed here, so decode it normally.
            decompress: true,
          }
          const response = await inner(endpoint!.uploadUrl, uploadInit)
          if (!response.ok) {
            void response.body?.cancel().catch(() => {})
            uploadFailed = true
            break
          }
          const file = endpoint!.parseUpload(await response.json())
          if (!file) {
            uploadFailed = true
            break
          }
          const localExpiry = startedAt + endpoint!.expiresAfterSeconds * 1000
          const serverExpiry = file.expiresAt ?? localExpiry
          const expiresAt = Math.min(localExpiry, serverExpiry) - 60_000
          if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
            uploadFailed = true
            break
          }
          cache.set(key, { id: file.id, expiresAt })
          for (const item of group) bytes -= item.replace(file.id)
          changed = true
          used.set(key, file.id)
        } catch {
          signal?.throwIfAborted()
          // Unsupported file auth/endpoints and transient upload failures keep
          // original media, letting the existing inference error path explain
          // the failure. Never silently delete visual context.
          uploadFailed = true
          break
        }
      }
      // Budget updates use per-block deltas. Serializing after every upload
      // creates gigabytes of temporary strings for screenshot-heavy histories.
      return changed ? JSON.stringify(body) : raw!
    }

    const send = (body: string) => {
      if (body === raw && used.size === 0) return inner(input, init)
      const nextHeaders = new Headers(headers)
      if (used.size) appendBeta(nextHeaders, endpoint.betaHeader)
      nextHeaders.delete('content-length')
      return inner(input, { ...init, method: 'POST', headers: nextHeaders, body, signal, redirect: 'error' })
    }
    // Validate the model/shape before allocating more copies or changing headers.
    if (endpoint.collectImages(original).length === 0) return inner(input, init)
    const prepared = await prepare(false)
    const response = await send(prepared)
    const stale = await isMissingFile(response, [...used.values()], (init as { decompress?: boolean } | undefined)?.decompress === false)
    if (stale) {
      // Even when another image's upload failed, never keep a known-bad ID.
      for (const key of used.keys()) cache.delete(key)
      used.clear()
    }
    if ((uploadFailed && !stale) || (response.status !== 413 && !stale)) return response
    const retry = await prepare(true, !uploadFailed)
    if (retry === prepared) return response
    void response.body?.cancel().catch(() => {})
    // Exactly one recovery attempt. The SDK owns any remaining error handling.
    return send(retry)
  }) as typeof fetch
}
