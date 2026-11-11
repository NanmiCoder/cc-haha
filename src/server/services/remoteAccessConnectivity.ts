import { getNetworkProxyFetchOptions, getNetworkProxyUrl, loadNetworkSettings, type NetworkSettings } from './networkSettings.js'

type Dependencies = {
  settings?: () => Promise<NetworkSettings>
  fetch?: typeof fetch
}

/** This result is only delivered over the authenticated loopback control API. */
export async function resolveRemoteAccessProxy(dependencies: Dependencies = {}): Promise<{ proxyUrl: string | null }> {
  const settings = await (dependencies.settings ?? loadNetworkSettings)()
  return { proxyUrl: getNetworkProxyUrl(settings) }
}

/** An edge registration alone does not prove that the configured hostname reaches this gateway. */
export async function verifyRemoteAccessGateway(origin: string, gatewayId: string, dependencies: Dependencies = {}): Promise<boolean> {
  const target = new URL('/health', origin)
  if (target.protocol !== 'https:' || target.origin !== origin || !gatewayId) return false
  try {
    const settings = await (dependencies.settings ?? loadNetworkSettings)()
    const response = await (dependencies.fetch ?? fetch)(target, {
      ...getNetworkProxyFetchOptions(settings, target),
      method: 'GET', redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' },
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return false
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > 4096) { await response.body?.cancel(); return false }
    const reader = response.body?.getReader()
    if (!reader) return false
    let body = ''
    const decoder = new TextDecoder()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        body += decoder.decode(chunk.value, { stream: true })
        if (body.length > 4096) { await reader.cancel(); return false }
      }
      body += decoder.decode()
    } finally { reader.releaseLock() }
    const value: unknown = JSON.parse(body)
    return !!value && typeof value === 'object' &&
      (value as Record<string, unknown>).status === 'ok' &&
      (value as Record<string, unknown>).gatewayId === gatewayId
  } catch { return false }
}
