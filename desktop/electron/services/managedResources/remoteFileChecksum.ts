import type { Client, ClientChannel } from 'ssh2'
import { quoteShellArgument } from './applicationOperationsIo.js'

export const REMOTE_HASH_THRESHOLD_BYTES = 16 * 1024 * 1024

/** Fixed read-only command. The filename is an argv value, not executable shell text. */
export function remoteChecksumCommand(absolutePath: string): string {
  const script = 'command -v sha256sum >/dev/null 2>&1 || exit 127; printf "CC_HAHA_VERIFY_V1\\n"; exec sha256sum < "$1"'
  return `exec sh -c ${quoteShellArgument(script)} cc-haha-verify ${quoteShellArgument(absolutePath)}`
}

/** null means exec/sha256sum is unavailable; integrity/runtime errors fail closed. */
export function remoteFileChecksum(input: {
  client: Client
  path: string
  size: number
  signal: AbortSignal
  checkpoint: () => void
  timeoutMs?: number
}): Promise<string | null> {
  if (typeof input.client.exec !== 'function') return Promise.resolve(null)
  input.checkpoint()
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined
    let finished = false
    let output = ''
    let exitCode: number | null = null
    const terminate = () => {
      try { channel?.signal('TERM') } catch { /* Only the hash collector channel. */ }
      try { channel?.close(); channel?.destroy() } catch { /* Already closed. */ }
    }
    const finish = (error?: Error, value?: string | null) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      clearInterval(check)
      input.signal.removeEventListener('abort', abort)
      terminate()
      if (error) reject(error)
      else {
        try { input.checkpoint(); resolve(value ?? null) } catch (failure) { reject(failure) }
      }
    }
    const abort = () => finish(input.signal.reason instanceof Error ? input.signal.reason : new Error('CANCELLED'))
    // A hash emits nothing until done. Use a size-aware total deadline, not the
    // transfer idle timeout; cancellation and generation checks stay live.
    const timeout = input.timeoutMs ?? Math.min(30 * 60_000, Math.max(120_000, Math.ceil(input.size / (4 * 1024 * 1024)) * 1000 + 30_000))
    const deadline = setTimeout(() => finish(new Error('VERIFY_TIMEOUT')), timeout)
    const check = setInterval(() => { try { input.checkpoint() } catch (failure) { finish(failure as Error) } }, 250)
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) { abort(); return }
    try {
      input.client.exec(remoteChecksumCommand(input.path), (error, stream) => {
        if (error) { finish(undefined, null); return }
        channel = stream
        stream.on('error', () => finish(new Error('CONNECTION_LOST')))
        stream.stderr.on('error', () => finish(new Error('CONNECTION_LOST')))
        if (finished) { terminate(); return }
        stream.on('data', (bytes: Buffer) => {
          if (finished) return
          output += bytes.toString('ascii')
          if (output.length > 512) finish(new Error('VERIFY_RESPONSE_INVALID'))
        })
        stream.stderr.resume()
        stream.once('exit', (code: number) => { exitCode = code })
        stream.once('close', () => {
          if (exitCode === 127) { finish(undefined, null); return }
          if (exitCode !== 0) { finish(new Error('REMOTE_VERIFY_FAILED')); return }
          const match = /^CC_HAHA_VERIFY_V1\r?\n([a-fA-F0-9]{64}) [ *]-\r?\n?$/.exec(output)
          if (!match) { finish(new Error('VERIFY_RESPONSE_INVALID')); return }
          finish(undefined, match[1]!.toLowerCase())
        })
        stream.end()
      })
    } catch { finish(undefined, null) }
  })
}
