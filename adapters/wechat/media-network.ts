/** Trusted WeChat media transport. Never forward bot credentials to the CDN. */
export function assertWechatMediaUrl(value: string, service: 'api' | 'cdn'): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Invalid WeChat media URL') }
  const host = url.hostname.toLowerCase()
  const trusted = service === 'api'
    ? host === 'ilinkai.weixin.qq.com' || host.endsWith('.ilinkai.weixin.qq.com')
    : host === 'novac2c.cdn.weixin.qq.com' || host === 'findermp.video.qq.com'
  if (!trusted || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Untrusted WeChat media URL')
  }
  return url
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'))
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

export async function fetchWechatMediaResource(params: {
  url: string
  service: 'api' | 'cdn'
  init?: RequestInit
  maxBytes: number
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<{ bytes: Buffer; headers: Headers; status: number }> {
  const url = assertWechatMediaUrl(params.url, params.service)
  const controller = new AbortController()
  const cancel = () => controller.abort(params.signal?.reason)
  params.signal?.addEventListener('abort', cancel, { once: true })
  if (params.signal?.aborted) cancel()
  const timer = setTimeout(() => controller.abort(new DOMException('WeChat media request timed out', 'TimeoutError')), params.timeoutMs ?? 30_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    controller.signal.throwIfAborted()
    const response = await abortable(fetch(url.toString(), {
      ...params.init,
      redirect: 'error',
      signal: controller.signal,
    }), controller.signal)
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error(`WeChat media HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > params.maxBytes) {
      void response.body?.cancel().catch(() => {})
      throw new Error('WeChat media exceeds size limit')
    }
    reader = response.body?.getReader()
    const chunks: Buffer[] = []
    let total = 0
    while (reader) {
      const result = await abortable(reader.read(), controller.signal)
      if (result.done) break
      total += result.value.byteLength
      if (total > params.maxBytes) throw new Error('WeChat media exceeds size limit')
      chunks.push(Buffer.from(result.value))
    }
    return { bytes: Buffer.concat(chunks, total), headers: response.headers, status: response.status }
  } finally {
    clearTimeout(timer)
    params.signal?.removeEventListener('abort', cancel)
    void reader?.cancel().catch(() => {})
  }
}
