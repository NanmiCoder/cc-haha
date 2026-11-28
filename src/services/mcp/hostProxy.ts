import type { getProxyFetchOptions } from '../../utils/proxy.js'
import { McpConnectionError } from './connectionErrors.js'

export type McpProxyFetchOptions = Omit<ReturnType<typeof getProxyFetchOptions>, 'proxy'> & { proxy?: string | false }
export type McpHostProxyResolver = (targetUrl: string) => Promise<McpProxyFetchOptions>

const hostProxyRegistrations: Array<{ resolver: McpHostProxyResolver }> = []

/**
 * Lets a host process route the MCP connections it opens itself through its
 * own network setting. The desktop server needs this: its host starts it with
 * the proxy variables cleared and passes the system proxy separately, so
 * HTTPS_PROXY is empty there. A CLI registers nothing and keeps the
 * environment proxy. Returns a function that removes this resolver.
 */
export function setMcpHostProxyResolver(resolver: McpHostProxyResolver): () => void {
  const registration = { resolver }
  hostProxyRegistrations.push(registration)
  return () => {
    const index = hostProxyRegistrations.indexOf(registration)
    if (index !== -1) hostProxyRegistrations.splice(index, 1)
  }
}

/** The host's proxy options for an MCP endpoint, or undefined when no host registered one. */
export async function resolveMcpHostProxy(targetUrl: string | URL): Promise<McpProxyFetchOptions | undefined> {
  const registration = hostProxyRegistrations.at(-1)
  if (!registration) return undefined
  try {
    return await registration.resolver(String(targetUrl))
  } catch {
    throw new McpConnectionError('proxy')
  }
}
