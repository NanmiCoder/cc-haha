export {}

/** Offline CLI preload. The real provider URL is preserved up to the fetch seam. */
const origin = process.env.MOCK_PROVIDER_MEDIA_ORIGIN
if (!origin || new URL(origin).origin !== origin || new URL(origin).hostname !== '127.0.0.1') {
  throw new Error('Mock provider media transport requires a loopback origin')
}
const originalFetch = globalThis.fetch
const fixtureFetch: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin === 'https://api.deepseek.com' && [
    '/files', '/anthropic/v1/messages', '/anthropic/v1/messages/count_tokens',
  ].includes(url.pathname)) {
    const target = `${origin}${url.pathname}${url.search}`
    return originalFetch(input instanceof Request ? new Request(target, input) : target, init)
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`Mock provider media lane blocked external fetch: ${url.origin}`)
  }
  return originalFetch(input, init)
}, originalFetch)
globalThis.fetch = fixtureFetch
