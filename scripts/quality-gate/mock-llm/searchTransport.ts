export {}

/** Test-process preload: intercept the fixed production search URL before DNS. */
const origin = process.env.MOCK_SEARCH_ORIGIN
if (!origin || new URL(origin).hostname !== '127.0.0.1') {
  throw new Error('Mock search transport requires a loopback origin')
}
const originalFetch = globalThis.fetch
const fixtureFetch: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.href === 'https://api.deepseek.com/v1/tools/search') {
    const target = `${origin}/v1/tools/search`
    return originalFetch(input instanceof Request ? new Request(target, input) : target, init)
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`Mock agent lane blocked external fetch: ${url.origin}`)
  }
  return originalFetch(input, init)
}, originalFetch)
globalThis.fetch = fixtureFetch
