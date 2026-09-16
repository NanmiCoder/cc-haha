import { ApiError } from '../middleware/errorHandler.js'
import type { WorkspaceService } from '../services/workspaceService.js'

export async function handleWorkspaceWatchRoute(
  req: Request,
  sessionId: string,
  url: URL,
  service: Pick<WorkspaceService, 'watchDirectories'>,
): Promise<Response> {
  const directories = url.searchParams.getAll('path')
  if (directories.length === 0 || directories.length > 64) throw ApiError.badRequest('Watch requires 1 to 64 directory paths')

  const abort = new AbortController()
  const relayAbort = () => abort.abort()
  req.signal.addEventListener('abort', relayAbort, { once: true })
  if (req.signal.aborted) abort.abort()
  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let stop: (() => void) | undefined
  let closed = false
  let output: ReadableStreamDefaultController<Uint8Array>
  const close = () => {
    if (closed) return
    closed = true
    abort.abort()
    stop?.()
    clearInterval(heartbeat)
    req.signal.removeEventListener('abort', relayAbort)
    try { output.close() } catch { /* The consumer may have cancelled first. */ }
  }
  const send = (value: unknown) => {
    if (!closed && !abort.signal.aborted) output.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { output = controller },
    cancel: close,
  })
  abort.signal.addEventListener('abort', close, { once: true })
  try {
    stop = await service.watchDirectories(sessionId, directories, (event) => send({ type: 'change', ...event }), abort.signal, (error) => {
      send({ type: 'error', message: error.message })
      close()
    })
    if (closed || abort.signal.aborted) {
      stop()
      close()
    } else {
      // Ready is sent after native watchers attach. The client refreshes once
      // here to close the gap between its last read and this subscription.
      send({ type: 'ready' })
      heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15_000)
    }
  } catch (error) {
    close()
    throw error
  }
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  })
}
