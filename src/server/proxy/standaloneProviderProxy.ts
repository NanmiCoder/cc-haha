import { handleProxyRequest } from './handler.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'

let standaloneProviderProxy: ReturnType<typeof Bun.serve> | null = null
let unregisterCleanup: (() => void) | undefined

export function ensureStandaloneProviderProxy(): number {
  if (standaloneProviderProxy) {
    return standaloneProviderProxy.port
  }

  standaloneProviderProxy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' })
      }
      if (url.pathname.startsWith('/proxy/')) {
        return handleProxyRequest(req, url)
      }
      return Response.json({ error: 'Not Found' }, { status: 404 })
    },
  })
  unregisterCleanup = registerCleanup(async () => stopStandaloneProviderProxy())

  return standaloneProviderProxy.port
}

function stopStandaloneProviderProxy(): void {
  standaloneProviderProxy?.stop(true)
  standaloneProviderProxy = null
  unregisterCleanup?.()
  unregisterCleanup = undefined
}

export const stopStandaloneProviderProxyForTests = stopStandaloneProviderProxy
