import type { getProxyFetchOptions } from '../../utils/proxy.js'

export type McpProxyFetchOptions = ReturnType<typeof getProxyFetchOptions>
export type McpHostProxyResolver = (targetUrl: string) => Promise<McpProxyFetchOptions>

let hostProxyResolver: McpHostProxyResolver | undefined

/**
 * Lets a host process route the MCP connections it opens itself through its
 * own network setting. The desktop server needs this: its host starts it with
 * the proxy variables cleared and passes the system proxy separately, so
 * HTTPS_PROXY is empty there. A CLI registers nothing and keeps the
 * environment proxy. Returns a function that removes this resolver.
 */
export function setMcpHostProxyResolver(resolver: McpHostProxyResolver): () => void {
  hostProxyResolver = resolver
  return () => {
    if (hostProxyResolver === resolver) hostProxyResolver = undefined
  }
}

/** The host's proxy options for an MCP endpoint, or undefined when no host registered one. */
export async function resolveMcpHostProxy(targetUrl: string | URL): Promise<McpProxyFetchOptions | undefined> {
  return hostProxyResolver?.(String(targetUrl))
}
