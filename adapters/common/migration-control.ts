import { timingSafeEqual } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { adapterMigrationLifecycle } from './migration-lifecycle.js'

/** An inherited anonymous pipe is available only to the owning desktop host. */
export function installAdapterMigrationControl(options: {
  token: string
  input?: Readable
  output?: Writable
  quiesce?: () => Promise<void>
  exit?: (code: number) => void
}): void {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const exit = options.exit ?? (code => process.exit(code))
  let buffer = ''
  let stopping = false
  input.on('data', chunk => {
    buffer += chunk.toString()
    if (buffer.length > 8192) {
      buffer = ''
      return
    }
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      let request: { type?: string; token?: string; requestId?: string }
      try { request = JSON.parse(line) } catch { continue }
      if (stopping || request.type !== 'migration_quiesce' || typeof request.token !== 'string' || typeof request.requestId !== 'string') continue
      const actual = Buffer.from(request.token)
      const expected = Buffer.from(options.token)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) continue
      stopping = true
      void (options.quiesce ?? (() => adapterMigrationLifecycle.quiesce()))().then(() => {
        output.write(JSON.stringify({ type: 'migration_quiesced', requestId: request.requestId }) + '\n', () => exit(0))
      }, () => {
        output.write(JSON.stringify({ type: 'migration_quiesce_failed', requestId: request.requestId }) + '\n', () => exit(1))
      })
    }
  })
}
