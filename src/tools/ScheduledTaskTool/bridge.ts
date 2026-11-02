import { getSessionBridgeConfig } from '../SessionCollaborationTool/bridge.js'

export async function callScheduledTaskBridge(input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const config = getSessionBridgeConfig()
  if (!config) throw new Error('ScheduledTask is only available in desktop conversations')
  const response = await fetch(`${config.endpoint}/api/scheduled-task-tools`, {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${config.token}`, 'X-Session-Id': config.sessionId, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    const expected = ['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT'].includes(error?.error)
    const detail = expected && typeof error.message === 'string' ? `: ${error.message.slice(0, 2000)}` : ''
    throw new Error(`ScheduledTask failed (${response.status})${detail}`)
  }
  const result: unknown = await response.json()
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid ScheduledTask response')
  return result as Record<string, unknown>
}
