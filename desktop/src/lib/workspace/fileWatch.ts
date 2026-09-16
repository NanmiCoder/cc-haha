import { ApiError, getApiUrl, getAuthToken } from '../../api/client'

export type WorkspaceWatchEvent =
  | { type: 'ready' | 'heartbeat' }
  | { type: 'change'; paths: string[]; directories: string[] }
  | { type: 'error'; message: string }

function parseEvent(raw: string): WorkspaceWatchEvent | null {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || !('type' in value)) return null
  if (value.type === 'ready' || value.type === 'heartbeat') return { type: value.type }
  if (value.type === 'error' && 'message' in value && typeof value.message === 'string') return { type: 'error', message: value.message }
  if (value.type === 'change' && 'paths' in value && 'directories' in value &&
    Array.isArray(value.paths) && value.paths.every((path) => typeof path === 'string') &&
    Array.isArray(value.directories) && value.directories.every((path) => typeof path === 'string')) {
    return { type: 'change', paths: value.paths, directories: value.directories }
  }
  return null
}

/** Fetch streaming keeps the same bearer authentication as every workspace read. */
export async function streamWorkspaceWatch(
  sessionId: string,
  directories: string[],
  signal: AbortSignal,
  onEvent: (event: WorkspaceWatchEvent) => void,
): Promise<void> {
  const query = new URLSearchParams()
  for (const path of directories) query.append('path', path)
  const token = getAuthToken()
  const response = await fetch(getApiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/watch?${query}`), {
    headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal,
  })
  if (!response.ok) throw new ApiError(response.status, await response.text())
  if (!response.body) throw new Error('Workspace watch did not return a stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done || signal.aborted) break
      pending += decoder.decode(value, { stream: true })
      if (pending.length > 1_048_576) throw new Error('Workspace watch event exceeds its limit')
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trimEnd()
        pending = pending.slice(newline + 1)
        if (!line.startsWith('data: ')) continue
        const event = parseEvent(line.slice(6))
        if (event && !signal.aborted) onEvent(event)
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
