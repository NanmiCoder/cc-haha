import {
  createOfficialAgentSdkBridge,
  parseOfficialAgentSdkArgs,
  type OfficialAgentSdkBridge,
} from '../server/services/officialAgentSdkBridge.js'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { createOfficialAgentSdkExtensions } from '../server/services/officialAgentSdkExtensions.js'

/** The scheduler uses the same SDK bridge without an interactive WebSocket. */
export async function serveOfficialAgentSdkStdio(
  createBridge: (send: (message: Record<string, unknown>) => void) => OfficialAgentSdkBridge | Promise<OfficialAgentSdkBridge>,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  // Subscribe immediately: the host can write the first prompt while native
  // SDK initialization is still pending.
  const pendingLines = lines[Symbol.asyncIterator]()
  let stopped = false
  let failed = false
  let shutdownReason: string | undefined
  let bridge: OfficialAgentSdkBridge | undefined
  const shutdown = (signal: string) => {
    shutdownReason = signal
    bridge?.close()
    lines.close()
  }
  const onTerm = () => shutdown('SIGTERM')
  const onInterrupt = () => shutdown('SIGINT')
  process.once('SIGTERM', onTerm)
  process.once('SIGINT', onInterrupt)
  try {
    bridge = await createBridge(message => {
      output.write(JSON.stringify(message) + '\n')
      if (message.type === 'result' && message.is_error === true) failed = true
      // Unattended tasks have no approval UI. Bypass permissions is explicitly
      // selected by the scheduler; interactive questions still fail closed.
      if (message.type === 'control_request' && typeof message.request_id === 'string') {
        queueMicrotask(() => {
          if (stopped) return
          void bridge?.receive(JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success', request_id: message.request_id,
              response: { behavior: 'deny', message: 'This scheduled task cannot request interactive input.', interrupt: true },
            },
          })).catch(() => bridge?.close())
        })
      }
    })
    if (shutdownReason) throw new Error(`Official Agent SDK task interrupted by ${shutdownReason}`)
    const active = bridge
    const consume = (async () => {
      await active.ready
      for await (const line of pendingLines) {
        if (stopped) break
        if (line.trim()) await active.receive(line)
      }
      if (!stopped) await active.receive(JSON.stringify({
        type: 'control_request', request_id: crypto.randomUUID(),
        request: { subtype: 'end_session', reason: 'stdin_closed' },
      }))
      await active.done
    })()
    await Promise.race([active.done, consume])
    if (shutdownReason) throw new Error(`Official Agent SDK task interrupted by ${shutdownReason}`)
    if (failed) throw new Error('Official Agent SDK task returned an error result')
  } finally {
    stopped = true
    lines.close()
    bridge?.close()
    process.removeListener('SIGTERM', onTerm)
    process.removeListener('SIGINT', onInterrupt)
  }
}

/** Runs only the official SDK. The legacy CLI preload and transport are not loaded. */
export async function runOfficialAgentSdk(args = process.argv.slice(2)): Promise<void> {
  const config = parseOfficialAgentSdkArgs(args)
  const { query } = await import('@anthropic-ai/claude-agent-sdk/core')
  if (config.transport === 'stdio') {
    return serveOfficialAgentSdkStdio(async send => {
      const extensions = await createOfficialAgentSdkExtensions(config, { query, send })
      try { return createOfficialAgentSdkBridge(config, { query, send, extensions }) }
      catch (error) { await extensions.close?.(); throw error }
    })
  }
  let socket: WebSocket | undefined
  let bridge: OfficialAgentSdkBridge | undefined
  const pending: Record<string, unknown>[] = []
  const send = (message: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message) + '\n')
    else pending.push(message)
  }
  const extensions = await createOfficialAgentSdkExtensions(config, { query, send })

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const connectionTimeout = setTimeout(() => finish(new Error('The official Agent SDK did not initialize and connect')), 25_000)
    const shutdown = () => finish()

    function finish(error?: unknown): void {
      if (settled) return
      settled = true
      clearTimeout(connectionTimeout)
      process.removeListener('SIGTERM', shutdown)
      process.removeListener('SIGINT', shutdown)
      try { bridge?.close() } finally { socket?.close() }
      if (!bridge) void extensions.close?.()
      if (error) reject(error)
      else resolve()
    }

    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
    try {
      bridge = createOfficialAgentSdkBridge(config, {
        query,
        send,
        extensions,
      })
      void bridge.done.then(() => finish(), error => finish(error))
      // Attaching is the host's readiness boundary: the official process must
      // pass its session-ID check before the host restores launch metadata.
      void bridge.ready.then(() => {
        if (settled) return
        const connected = socket = new WebSocket(config.sdkUrl!)
        connected.addEventListener('open', () => {
          clearTimeout(connectionTimeout)
          if (settled) return
          for (const message of pending.splice(0)) connected.send(JSON.stringify(message) + '\n')
        })
        connected.addEventListener('message', event => {
          if (settled) return
          if (!bridge || typeof event.data !== 'string') {
            finish(new Error('The local SDK transport sent an invalid message'))
            return
          }
          // Permission replies must remain deliverable during control calls.
          void bridge.receive(event.data).catch(error => finish(error))
        })
        connected.addEventListener('close', () => finish())
        connected.addEventListener('error', () => finish(new Error('The local SDK transport failed')))
      }, error => finish(error))
    } catch (error) {
      finish(error)
    }
  })
}

if (import.meta.main) await runOfficialAgentSdk()
