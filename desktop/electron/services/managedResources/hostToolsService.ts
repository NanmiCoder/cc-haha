import type { ClientChannel } from 'ssh2'
import { HostToolsInputSchema, type HostToolsInput, type HostToolsResult } from '../../../src/features/managed-resources/api/hostToolsApi.js'
import type { ManagedResourcesServices } from './registerIpc.js'
import { createHostToolsPreferences, type HostToolsPreferencesRepository } from './hostToolsPreferences.js'
import { JAVA_PROCESS_COMMAND, parseJavaProcesses } from './javaProcessProtocol.js'

type Services = Pick<ManagedResourcesServices, 'store' | 'sshService'>
type Query = Extract<HostToolsInput, { action: 'listJava' }>
export function createHostToolsService(services: Services, preferences: HostToolsPreferencesRepository = createHostToolsPreferences(services.store)) {
  const active = new Map<string, { owner: string; controller: AbortController }>()
  const cancelled = new Map<string, { owner: string; until: number }>()
  let disposed = false
  function connection(input: Query, owner: string) {
    const value = services.sshService.getInternalsForOwner(input.connectionId, owner)
    if (!value || value.session.hostId !== input.hostId) throw new Error('UNAUTHORIZED_OWNER')
    if (value.generation !== input.generation) throw new Error('STALE_GENERATION')
    if (value.session.status !== 'ready') throw new Error('DISCONNECTED')
    return value
  }
  async function query(input: Query, owner: string, signal: AbortSignal): Promise<string> {
    const { client } = connection(input, owner)
    return new Promise((resolve, reject) => {
      let channel: ClientChannel | undefined
      let finished = false
      let size = 0
      let exitCode: number | null = null
      const chunks: Buffer[] = []
      const close = () => {
        try { channel?.signal('TERM') } catch { /* Only the read-only collector, never another process. */ }
        try { channel?.close(); channel?.destroy() } catch { /* Only this query's channel. */ }
      }
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        clearTimeout(deadline); clearInterval(check)
        signal.removeEventListener('abort', abort)
        close()
        if (error) reject(error)
        else resolve(Buffer.concat(chunks, size).toString('utf8'))
        chunks.length = 0
      }
      const abort = () => finish(new Error('CANCELLED'))
      const deadline = setTimeout(() => finish(new Error('OPERATION_TIMEOUT')), 20000)
      const check = setInterval(() => { try { connection(input, owner) } catch (error) { finish(error as Error) } }, 250)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      try {
        client.exec(JAVA_PROCESS_COMMAND, (error, stream) => {
          if (error) { finish(new Error('PROCESS_QUERY_FAILED')); return }
          channel = stream
          stream.on('error', () => finish(new Error('CONNECTION_LOST')))
          stream.stderr.on('error', () => finish(new Error('CONNECTION_LOST')))
          if (finished) { close(); return }
          stream.on('data', (data: Buffer) => {
            if (finished) return
            size += data.length
            if (size > 8 * 1024 * 1024) { finish(new Error('PROCESS_OUTPUT_LIMIT')); return }
            chunks.push(Buffer.from(data))
          })
          stream.stderr.resume() // Never log remote command lines or stderr into trace/history.
          stream.once('exit', (code: number) => { exitCode = code })
          stream.once('close', () => finish(exitCode === 0 ? undefined : new Error('PROCESS_QUERY_FAILED')))
          stream.end() // The collector never requests passwords or interactive input.
        })
      } catch { finish(new Error('PROCESS_QUERY_FAILED')) }
    })
  }
  return {
    async perform(raw: HostToolsInput, owner: string): Promise<HostToolsResult> {
      if (disposed) throw new Error('DISCONNECTED')
      const input = HostToolsInputSchema.parse(raw)
      if (input.action === 'getPreferences') return { kind: 'preferences', preferences: await preferences.get(input.scope) }
      if (input.action === 'savePreferences') return { kind: 'preferences', preferences: await preferences.patch(input.scope, input.patch) }
      for (const [id, entry] of cancelled) if (entry.until < Date.now()) cancelled.delete(id)
      if (input.action === 'cancelJava') {
        const job = active.get(input.requestId)
        const previous = cancelled.get(input.requestId)
        if ((job && job.owner !== owner) || (previous && previous.owner !== owner)) throw new Error('UNAUTHORIZED_OWNER')
        if (cancelled.size >= 256 && !previous) throw new Error('OPERATION_LIMIT')
        cancelled.set(input.requestId, { owner, until: Date.now() + 60000 })
        job?.controller.abort()
        return { kind: 'cancelled' }
      }
      connection(input, owner)
      if (cancelled.has(input.requestId)) throw new Error('CANCELLED')
      if (active.has(input.requestId) || active.size >= 8) throw new Error('OPERATION_LIMIT')
      const controller = new AbortController()
      active.set(input.requestId, { owner, controller })
      try {
        const text = await query(input, owner, controller.signal)
        connection(input, owner)
        return { kind: 'java', ...parseJavaProcesses(text), sampledAt: new Date().toISOString() }
      } finally { active.delete(input.requestId) }
    },
    dispose() { disposed = true; for (const value of active.values()) value.controller.abort(); cancelled.clear() },
  }
}
