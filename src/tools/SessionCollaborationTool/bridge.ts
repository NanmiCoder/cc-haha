export function getSessionBridgeConfig() {
  const endpoint = process.env.CC_HAHA_DESKTOP_SERVER_URL
  const token = process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN
  const sessionId = process.env.CC_HAHA_SESSION_ID
  if (!endpoint || !token || !sessionId) return undefined
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Session collaboration requires a loopback desktop server')
  }
  return { endpoint: url.origin, token, sessionId }
}

export function isSessionBridgeAvailable(): boolean {
  try { return getSessionBridgeConfig() !== undefined } catch { return false }
}

export async function callSessionBridge(action: string, input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const config = getSessionBridgeConfig()
  if (!config) throw new Error('Session collaboration is only available in desktop sessions')
  const response = await fetch(`${config.endpoint}/api/session-collaboration/${action}`, {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${config.token}`, 'X-Session-Id': config.sessionId, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(305_000)]) : AbortSignal.timeout(305_000),
  })
  if (!response.ok) {
    // Only expose the host's structured, expected API errors. Never include
    // arbitrary proxy bodies, stack traces, or internal diagnostics.
    const error = await response.json().catch(() => null)
    const expected = ['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'WAIT_INTERRUPTED'].includes(error?.error)
    const detail = expected && typeof error.message === 'string' ? `: ${error.message.slice(0, 1000)}` : ''
    throw new Error(`Session collaboration ${action} failed (${response.status})${detail}`)
  }
  const result: unknown = await response.json()
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid session collaboration response')
  return result as Record<string, unknown>
}
