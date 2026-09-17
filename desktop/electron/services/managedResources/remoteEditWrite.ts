import crypto from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { RemoteEditSession } from './sftpService.js'

/** Only bounded codes leave this module; server error text may contain local paths. */
function failure(error: unknown, replacing = false): Error {
  const code = String((error as { code?: string | number })?.code ?? '')
  const message = error instanceof Error ? error.message : ''
  if (/^(REVISION_CONFLICT|STALE_GENERATION|DISCONNECTED|UNAUTHORIZED_OWNER|FILE_TOO_LARGE|IS_SYMLINK|NOT_A_FILE|CHECKSUM_MISMATCH|SIZE_MISMATCH|ATOMIC_REPLACE_UNSUPPORTED|SAVE_IN_PROGRESS)$/.test(message)) return new Error(message)
  if (code === '3' || code === 'EACCES' || code === 'EPERM') return new Error('PERMISSION_DENIED')
  if (code === '2' || code === 'ENOENT') return new Error('RESOURCE_NOT_FOUND')
  if (code === '8' || message === 'Server does not support this extended request') return new Error('ATOMIC_REPLACE_UNSUPPORTED')
  if (['6', '7', 'ECONNRESET', 'EPIPE', 'ENOTCONN'].includes(code) || /No response from server|Connection lost|Channel closed/i.test(message)) return new Error('CONNECTION_LOST')
  if (code === 'ENOSPC') return new Error('NO_SPACE')
  if (message === 'REMOTE_IO_TIMEOUT') return new Error('REMOTE_IO_TIMEOUT')
  return new Error(replacing ? 'SAVE_REPLACE_FAILED' : 'SFTP_OPERATION_FAILED')
}
function request<T>(start: (done: (error: Error | undefined | null, value?: T) => void) => void, replacing = false): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('REMOTE_IO_TIMEOUT')), 30_000)
    try {
      start((error, result) => { clearTimeout(timer); error ? reject(failure(error, replacing)) : resolve(result as T) })
    } catch (error) { clearTimeout(timer); reject(failure(error, replacing)) }
  })
}
const timestamp = (attrs: Stats & { mtimeMs?: number }) => attrs.mtimeMs ?? attrs.mtime * 1000
const sha = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex')
function regular(attrs: Stats) {
  if ((attrs.mode & 0o170000) === 0o120000) throw new Error('IS_SYMLINK')
  if ((attrs.mode & 0o170000) !== 0o100000) throw new Error('NOT_A_FILE')
}
function readBounded(sftp: SFTPWrapper, file: string, max: number, check: () => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const source = sftp.createReadStream(file, { highWaterMark: 64 * 1024 })
    const chunks: Buffer[] = []
    let total = 0
    let ended = false
    let settled = false
    let readError: unknown
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks, total))
    }
    const timer = setTimeout(() => { finish(new Error('REMOTE_IO_TIMEOUT')); source.destroy() }, 30_000)
    source.on('error', (error: Error) => { readError = error; source.destroy() })
    source.on('data', (chunk: Buffer) => {
      if (settled || readError) return
      try {
        check()
        total += chunk.length
        if (total > max) throw new Error('FILE_TOO_LARGE')
        chunks.push(chunk)
      } catch (error) { readError = error; source.destroy() }
    })
    source.once('end', () => { ended = true })
    // SSH2 releases the remote handle asynchronously after EOF. Wait for CLOSE, not just END.
    source.once('close', () => {
      try { check(); finish(readError ?? (ended ? undefined : new Error('CONNECTION_LOST'))) }
      catch (error) { finish(error) }
    })
  })
}

/** Replace an existing remote file only after verified staging, never delete the target first. */
export async function writeRemoteEdit(sftp: SFTPWrapper, edit: RemoteEditSession, text: string, data: Buffer, max: number, check: () => void) {
  const payload = edit.hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data]) : data
  if (payload.length > max) throw new Error('FILE_TOO_LARGE')
  if (typeof sftp.ext_openssh_rename !== 'function') throw new Error('ATOMIC_REPLACE_UNSUPPORTED')
  const draft = path.posix.join(path.posix.dirname(edit.absolutePath), `.cc-haha-${crypto.randomUUID()}.editdraft`)
  let owned = false
  try {
    check()
    const current = await request<Stats>(done => sftp.lstat(edit.absolutePath, done))
    regular(current)
    const originalRevision = `${current.size}:${timestamp(current)}:${edit.baseSha256}`
    if (originalRevision !== edit.baseRevision || sha(await readBounded(sftp, edit.absolutePath, max, check)) !== edit.baseSha256) throw new Error('REVISION_CONFLICT')
    check()
    const writer = sftp.createWriteStream(draft, { flags: 'wx', mode: 0o600 })
    writer.once('open', () => { owned = true })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('REMOTE_IO_TIMEOUT')), 30_000)
    try { await pipeline(Readable.from([payload]), writer, { signal: controller.signal }) }
    finally { clearTimeout(timer) }
    check()
    // Restore regular permission bits, including executable bits, rather than forcing every script to 0644.
    await request<void>(done => sftp.chmod(draft, current.mode & 0o777, done))
    const staged = await request<Stats>(done => sftp.lstat(draft, done))
    const writtenHash = sha(payload)
    if (staged.size !== payload.length) throw new Error('SIZE_MISMATCH')
    if (sha(await readBounded(sftp, draft, max, check)) !== writtenHash) throw new Error('CHECKSUM_MISMATCH')
    const live = await request<Stats>(done => sftp.lstat(edit.absolutePath, done))
    regular(live)
    if (live.size !== current.size || timestamp(live) !== timestamp(current) || live.mode !== current.mode
      || sha(await readBounded(sftp, edit.absolutePath, max, check)) !== edit.baseSha256) throw new Error('REVISION_CONFLICT')
    check()
    // Standard SFTP v3 RENAME refuses an existing target. OpenSSH's extension provides atomic POSIX replacement.
    await request<void>(done => sftp.ext_openssh_rename(draft, edit.absolutePath, done), true)
    owned = false
    // Rename preserves the staged file's size/mtime. Avoid a post-commit stat making a completed save look failed.
    return { text, hash: writtenHash, size: payload.length, mtimeMs: timestamp(staged), mode: staged.mode }
  } catch (error) {
    if (owned) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 2000)
      try { sftp.unlink(draft, () => { clearTimeout(timer); resolve() }) }
      catch { clearTimeout(timer); resolve() }
    })
    if (error instanceof Error && ['PERMISSION_DENIED', 'RESOURCE_NOT_FOUND', 'SAVE_REPLACE_FAILED', 'CONNECTION_LOST', 'REMOTE_IO_TIMEOUT', 'NO_SPACE', 'SFTP_OPERATION_FAILED'].includes(error.message)) throw error
    throw failure(error)
  }
}
