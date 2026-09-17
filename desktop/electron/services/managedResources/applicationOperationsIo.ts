import { StringDecoder } from 'node:string_decoder'
import type { SFTPWrapper, Stats } from 'ssh2'

export const APPLICATION_OUTPUT_LIMIT = 256 * 1024
export function applicationError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const code = String((error as { code?: unknown })?.code ?? '')
  if (['2', 'ENOENT'].includes(code)) return 'RESOURCE_NOT_FOUND'
  if (['3', 'EACCES', 'EPERM'].includes(code)) return 'PERMISSION_DENIED'
  if (['6', '7', 'ECONNRESET', 'EPIPE'].includes(code)) return 'CONNECTION_LOST'
  return /^(INVALID_ARGUMENT|INVALID_REMOTE_PATH|UNAUTHORIZED_OWNER|DISCONNECTED|STALE_GENERATION|RESOURCE_NOT_FOUND|APPLICATION_CHANGED|DIRECTORY_LIMIT|IS_SYMLINK|NOT_A_FILE|NOT_A_DIRECTORY|REVISION_CONFLICT|OPERATION_LIMIT|REQUEST_ID_CONFLICT|OPERATION_TIMEOUT|BINARY_FILE|CANCELLED|EXIT_STATUS_UNKNOWN|SCRIPT_EXIT_FAILED|RUN_AS_CHANGED|PREFERENCES_INVALID|PREFERENCES_LIMIT)$/.test(message) ? message : 'SFTP_OPERATION_FAILED'
}
export function sftpRequest<T>(start: (done: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OPERATION_TIMEOUT')), 15_000)
    try { start((error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value as T) }) }
    catch (error) { clearTimeout(timer); reject(error) }
  })
}
export const applicationFileRevision = (attrs: Stats & { mtimeMs?: number }) => `${attrs.size}:${attrs.mtimeMs ?? attrs.mtime * 1000}:${attrs.mode}`
export function fileKind(mode: number): 'file' | 'directory' | 'symlink' | 'other' {
  return (mode & 0o170000) === 0o120000 ? 'symlink' : (mode & 0o170000) === 0o040000 ? 'directory' : (mode & 0o170000) === 0o100000 ? 'file' : 'other'
}
export const quoteShellArgument = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

/** A log preview is bounded independently of the edit limit and never executes HTML/ANSI. */
export async function applicationPreview(sftp: SFTPWrapper, absolutePath: string, size: number) {
  const limit = APPLICATION_OUTPUT_LIMIT
  const source = sftp.createReadStream(absolutePath, { start: 0, end: limit - 1, highWaterMark: 64 * 1024 })
  const chunks: Buffer[] = []
  let bytes = 0
  return new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
    let finished = false
    const timer = setTimeout(() => finish(new Error('OPERATION_TIMEOUT')), 15_000)
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      // Keep error listener through stream destruction; a late CLOSE error must not crash main.
      source.destroy()
      if (error) { reject(error); return }
      const buffer = Buffer.concat(chunks, bytes)
      if (buffer.includes(0)) { reject(new Error('BINARY_FILE')); return }
      const decoder = new StringDecoder('utf8')
      const text = decoder.write(buffer) + (size <= bytes ? decoder.end() : '')
      resolve({ text, truncated: size > bytes })
    }
    source.on('error', finish)
    source.on('data', (chunk: Buffer) => {
      if (finished) return
      const kept = chunk.subarray(0, limit - bytes)
      chunks.push(kept); bytes += kept.length
      if (bytes >= limit) finish()
    })
    source.once('end', () => finish())
    source.once('close', () => { if (!finished) finish(new Error('DISCONNECTED')) })
  })
}
