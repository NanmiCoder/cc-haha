import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper, Stats } from 'ssh2'
import { isM4FileName } from '../../../src/features/managed-resources/api/m4IpcContract.js'
import type { TransferJob, TransferService, TransferServiceOptions, FolderTransferInput } from './sftpService.js'

const terminal = (job: TransferJob) => ['completed', 'failed', 'cancelled'].includes(job.state)
const safeName = isM4FileName
const kind = (mode: number) => mode & 0o170000
function fail(code: string): never { throw new Error(code) }
const validRemote = (name: string) => name.startsWith('/') && name.length <= 4096
  && !name.includes('\0') && !name.includes('//') && !name.split('/').some(part => part === '.' || part === '..')

type Entry = { relative: string; directory: boolean; size: number; mode: number; mtime: number }
type Active = { controller: AbortController; committing: boolean; done: Promise<TransferJob> }

/** Streaming only: transfer bytes are never collected into a file-sized Buffer. */
export function createStreamingTransferService(options: TransferServiceOptions): TransferService {
  const jobs = new Map<string, TransferJob>()
  const active = new Map<string, Active>()
  const destinations = new Set<string>()
  let disposed = false
  const chunkSize = options.chunkSize ?? 64 * 1024
  const maxBytes = options.maxFileBytes ?? Number.MAX_SAFE_INTEGER
  const timeoutMs = options.idleTimeoutMs ?? 60_000
  const emit = (job: TransferJob) => options.emit?.({ type: 'transfer-update', job: { ...job } })
  const errorCode = (error: unknown) => {
    const message = error instanceof Error ? error.message : ''
    const code = String((error as { code?: string | number })?.code ?? '')
    if (code === 'EACCES' || code === 'EPERM' || code === '3') return 'PERMISSION_DENIED'
    if (code === 'ENOENT' || code === '2') return 'RESOURCE_NOT_FOUND'
    if (code === 'ENOSPC') return 'NO_SPACE'
    return /^(CANCELLED|STALE_GENERATION|DISCONNECTED|UNAUTHORIZED_OWNER|FILE_TOO_LARGE|SIZE_MISMATCH|CHECKSUM_MISMATCH|FILE_CHANGED|IS_SYMLINK|NOT_A_FILE|NOT_A_DIRECTORY|INVALID_LOCAL_PATH|INVALID_REMOTE_PATH|INVALID_FILENAME|TARGET_EXISTS|TREE_LIMIT_EXCEEDED|TRANSFER_TIMEOUT|RESOURCE_NOT_FOUND)$/.test(message) ? message : 'TRANSFER_FAILED'
  }

  function start(input: { jobId: string; connectionId: string; ownerId: string; generation: number; remotePath: string; localToken?: string; localRoot?: string }, upload: boolean, folder: boolean): Promise<TransferJob> {
    if (jobs.has(input.jobId)) return Promise.reject(new Error('DUPLICATE_JOB_ID'))
    if (disposed) return Promise.reject(new Error('CANCELLED'))
    if ([...active.keys()].filter(id => jobs.get(id)?.ownerId === input.ownerId).length >= 3) return Promise.reject(new Error('TRANSFER_LIMIT'))
    const controller = new AbortController()
    const job: TransferJob = {
      id: input.jobId, connectionId: input.connectionId, ownerId: input.ownerId, generation: input.generation,
      remotePath: input.remotePath, localPath: '', direction: upload ? 'upload' : 'download',
      state: 'preparing', size: 0, transferred: 0, checksum: null, error: null, startedAt: Date.now(), finishedAt: null,
      ...(folder ? { folder: true, entriesTotal: 0, entriesCompleted: 0 } : {}),
    }
    jobs.set(job.id, job)
    // Bound completed-job metadata without touching live transfers.
    if (jobs.size > 256) for (const [id, previous] of jobs) {
      if (id !== job.id && terminal(previous)) { jobs.delete(id); break }
    }
    const running: Active = { controller, committing: false, done: Promise.resolve(job) }
    active.set(job.id, running)
    emit(job)
    running.done = execute().finally(() => active.delete(job.id))
    return running.done

    async function execute(): Promise<TransferJob> {
      const { signal } = controller
      let sftp: SFTPWrapper | undefined
      let staging = ''
      let reserved = false
      let lock = ''
      let localRoot = ''
      let remoteRoot = input.remotePath
      const createdRemote: Array<{ name: string; directory: boolean }> = []
      const checkpoint = () => {
        if (signal.aborted) throw signal.reason ?? new Error('CANCELLED')
        const session = options.resolveSession(input)
        if (session.generation !== input.generation) fail('STALE_GENERATION')
        if (['closed', 'closing', 'failed', 'disconnected'].includes(session.session.status)) fail('DISCONNECTED')
      }
      const call = <T>(register: (done: (error: Error | undefined | null, result: T) => void) => void): Promise<T> => new Promise((resolve, reject) => {
        checkpoint()
        let settled = false
        const finish = (error: unknown, value?: T) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          if (error) reject(error)
          else { try { if (!running.committing) checkpoint(); resolve(value as T) } catch (err) { reject(err) } }
        }
        const abort = () => finish(signal.reason ?? new Error('CANCELLED'))
        const timer = setTimeout(() => finish(new Error('TRANSFER_TIMEOUT')), timeoutMs)
        signal.addEventListener('abort', abort, { once: true })
        try { register((err, value) => finish(err, value)) } catch (error) { finish(error) }
      })
      const lstat = (name: string) => call<Stats>(done => sftp!.lstat(name, done))
      const absentRemote = async (name: string) => {
        try { await lstat(name) } catch (error) {
          if ((error as { code?: number }).code === 2 || (error as { code?: string }).code === 'ENOENT') return
          throw error
        }
        fail('TARGET_EXISTS')
      }
      const absentLocal = async (name: string) => {
        try { await fs.lstat(name) } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error }
        fail('TARGET_EXISTS')
      }
      const checkDirectory = (mode: number) => {
        if (kind(mode) === 0o120000) fail('IS_SYMLINK')
        if (kind(mode) !== 0o040000) fail('NOT_A_DIRECTORY')
      }
      const checkFile = (size: number, mode: number) => {
        if (kind(mode) === 0o120000) fail('IS_SYMLINK')
        if (kind(mode) !== 0o100000) fail('NOT_A_FILE')
        if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) fail('FILE_TOO_LARGE')
      }
      const remoteParents = async (name: string) => {
        let current = '/'
        checkDirectory((await lstat(current)).mode)
        for (const part of name.split('/').filter(Boolean)) {
          current = path.posix.join(current, part)
          checkDirectory((await lstat(current)).mode)
        }
      }
      const stream = async (source: Readable, destination: Writable, size: number, progress: boolean): Promise<string> => {
        const hash = crypto.createHash('sha256')
        let count = 0
        let touched = Date.now()
        const timer = setInterval(() => {
          try { checkpoint(); if (Date.now() - touched > timeoutMs) fail('TRANSFER_TIMEOUT') }
          catch (err) { controller.abort(err) }
        }, Math.min(1000, timeoutMs))
        const meter = new Transform({ highWaterMark: chunkSize, transform(chunk: Buffer, _encoding, callback) {
          try {
            checkpoint()
            count += chunk.length
            if (count > size || count > maxBytes) fail('SIZE_MISMATCH')
            hash.update(chunk)
            touched = Date.now()
            if (progress) { job.transferred += chunk.length; emit(job) }
            callback(null, chunk)
          } catch (err) { callback(err as Error) }
        } })
        try {
          await pipeline(source, meter, destination, { signal })
          checkpoint()
          if (count !== size) fail('SIZE_MISMATCH')
          return hash.digest('hex')
        } catch (error) { throw signal.aborted ? signal.reason : error }
        finally { clearInterval(timer) }
      }
      const hashSink = () => new Writable({ write(_chunk, _encoding, done) { done() } })
      try {
        // Reject a foreign/expired/wrong-purpose token before opening SFTP.
        const localPath = folder ? input.localRoot : options.localPathService.resolveToken(input.localToken!, input.ownerId, upload ? 'upload-source' : 'download-target')
        if (!localPath || !path.isAbsolute(localPath)) fail('INVALID_LOCAL_PATH')
        checkpoint()
        if (!validRemote(input.remotePath)) fail('INVALID_REMOTE_PATH')
        sftp = (await options.sftpService.ensureSftp(input.connectionId, input.ownerId)).sftp
        checkpoint()
        localRoot = path.resolve(localPath)
        if (folder) {
          checkDirectory((await fs.lstat(localRoot)).mode)
          // Canonical native-selected root; children below it are never followed through links.
          localRoot = await fs.realpath(localRoot)
          const name = upload ? path.basename(localRoot) : path.posix.basename(remoteRoot)
          if (!safeName(name)) fail('INVALID_FILENAME')
          if (upload) remoteRoot = path.posix.join(remoteRoot, name)
          else localRoot = path.join(localRoot, name)
        }
        job.remotePath = remoteRoot
        job.localPath = localRoot
        lock = upload ? `${input.connectionId}:${remoteRoot}` : `local:${localRoot.toLowerCase()}`
        if (destinations.has(lock)) { lock = ''; fail('TARGET_EXISTS') }
        destinations.add(lock)
        await remoteParents(upload ? path.posix.dirname(remoteRoot) : folder ? remoteRoot : path.posix.dirname(remoteRoot))
        if (upload) await absentRemote(remoteRoot)
        else await absentLocal(localRoot)
        checkpoint()

        const entries: Entry[] = []
        async function walk(relative: string, depth: number): Promise<void> {
          checkpoint()
          if (depth > (options.maxDepth ?? 64) || entries.length >= (options.maxEntries ?? 50_000)) fail('TREE_LIMIT_EXCEEDED')
          const filename = upload ? path.join(localRoot, relative) : path.posix.join(remoteRoot, relative)
          const attrs = upload ? await fs.lstat(filename) : await lstat(filename)
          const directory = kind(attrs.mode) === 0o040000
          if (kind(attrs.mode) === 0o120000) fail('IS_SYMLINK')
          if (!directory) checkFile(attrs.size, attrs.mode)
          if (!folder && directory) fail('NOT_A_FILE')
          const mtime = 'mtimeMs' in attrs ? Number(attrs.mtimeMs) : Number(attrs.mtime) * 1000
          entries.push({ relative, directory, size: directory ? 0 : attrs.size, mode: attrs.mode, mtime })
          job.size += directory ? 0 : attrs.size
          if (!Number.isSafeInteger(job.size)) fail('FILE_TOO_LARGE')
          if (directory) {
            const children = upload ? await fs.readdir(filename) : (await call<Array<{ filename: string }>>(done => sftp!.readdir(filename, done as never))).map(item => item.filename)
            if (children.length + entries.length > (options.maxEntries ?? 50_000) + 2) fail('TREE_LIMIT_EXCEEDED')
            const names = new Set<string>()
            for (const name of children.filter(name => name !== '.' && name !== '..').sort()) {
              if (!safeName(name)) fail('INVALID_FILENAME')
              const key = name.normalize('NFC').toLowerCase()
              if (names.has(key)) fail('INVALID_FILENAME')
              names.add(key)
              await walk(relative ? `${relative}/${name}` : name, depth + 1)
            }
          }
        }
        await walk('', 0)
        if (folder) job.entriesTotal = entries.length
        staging = upload ? path.posix.join(path.posix.dirname(remoteRoot), `.cc-haha-${job.id}-${crypto.randomUUID()}.part`)
          : path.join(path.dirname(localRoot), `.cc-haha-${job.id}-${crypto.randomUUID()}.part`)
        checkpoint()
        if (folder) {
          if (upload) {
            await call<void>(done => sftp!.mkdir(staging, { mode: 0o700 }, done as never))
            createdRemote.push({ name: staging, directory: true })
          } else await fs.mkdir(staging, { mode: 0o700 })
          reserved = true
        }
        for (const entry of entries) {
          checkpoint()
          const from = upload ? path.join(localRoot, entry.relative) : path.posix.join(remoteRoot, entry.relative)
          const to = upload ? path.posix.join(staging, entry.relative) : path.join(staging, entry.relative)
          if (entry.directory) {
            if (entry.relative) {
              if (upload) {
                await call<void>(done => sftp!.mkdir(to, { mode: entry.mode & 0o777 }, done as never))
                createdRemote.push({ name: to, directory: true })
              } else await fs.mkdir(to)
            }
          } else {
            const before = upload ? await fs.lstat(from) : await lstat(from)
            checkFile(before.size, before.mode)
            const beforeStamp = 'mtimeMs' in before ? Number(before.mtimeMs) : Number(before.mtime) * 1000
            if (before.size !== entry.size || beforeStamp !== entry.mtime) fail('FILE_CHANGED')
            job.state = 'in_progress'
            emit(job)
            const source = upload ? createReadStream(from, { highWaterMark: chunkSize }) : sftp!.createReadStream(from, { highWaterMark: chunkSize })
            const destination = upload ? sftp!.createWriteStream(to, { flags: 'wx', mode: entry.mode & 0o777, highWaterMark: chunkSize }) : createWriteStream(to, { flags: 'wx', highWaterMark: chunkSize })
            destination.once('open', () => { reserved = true; if (upload) createdRemote.push({ name: to, directory: false }) })
            const checksum = await stream(source, destination, entry.size, true)
            job.state = 'verifying'
            emit(job)
            const reread = upload ? sftp!.createReadStream(to, { highWaterMark: chunkSize }) : createReadStream(to, { highWaterMark: chunkSize })
            if (await stream(reread, hashSink(), entry.size, false) !== checksum) fail('CHECKSUM_MISMATCH')
            const after = upload ? await fs.lstat(from) : await lstat(from)
            const stamp = 'mtimeMs' in after ? Number(after.mtimeMs) : Number(after.mtime) * 1000
            if (after.size !== entry.size || stamp !== entry.mtime) fail('FILE_CHANGED')
            if (!folder) job.checksum = checksum
          }
          if (folder) { job.entriesCompleted = (job.entriesCompleted ?? 0) + 1; emit(job) }
        }
        checkpoint()
        if (upload) await absentRemote(remoteRoot)
        else await absentLocal(localRoot)
        checkpoint()
        // A rename already submitted is a commit point; cancellation cannot claim to undo it.
        running.committing = true
        if (upload) await call<void>(done => sftp!.rename(staging, remoteRoot, done as never))
        else await fs.rename(staging, localRoot)
        reserved = false
        job.state = 'completed'
      } catch (error) {
        const code = signal.aborted && signal.reason ? errorCode(signal.reason) : errorCode(error)
        job.state = code === 'CANCELLED' ? 'cancelled' : 'failed'
        job.error = code === 'FILE_TOO_LARGE' ? { code, size: job.size, max: maxBytes } : { code } as TransferJob['error']
        if (reserved && staging) {
          if (upload && sftp) {
            // Only entries created in this unique staging tree, never user files or another job.
            const cleanupDeadline = Date.now() + 5000
            for (const item of createdRemote.reverse()) {
              if (Date.now() >= cleanupDeadline) break
              await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, Math.min(2000, cleanupDeadline - Date.now()))
                const done = () => { clearTimeout(timer); resolve() }
                try { if (item.directory) sftp!.rmdir(item.name, done); else sftp!.unlink(item.name, done) } catch { done() }
              })
            }
          } else if (!upload) await fs.rm(staging, { recursive: folder, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
        }
      } finally {
        if (lock) destinations.delete(lock)
        job.finishedAt = Date.now()
        emit(job)
      }
      return { ...job }
    }
  }
  return {
    startUpload: input => start(input, true, false),
    startDownload: input => start(input, false, false),
    startFolderUpload: (input: FolderTransferInput) => start(input, true, true),
    startFolderDownload: (input: FolderTransferInput) => start(input, false, true),
    async cancel(id, ownerId) {
      const job = jobs.get(id)
      if (!job) fail('RESOURCE_NOT_FOUND')
      if (job.ownerId !== ownerId) fail('UNAUTHORIZED_OWNER')
      const running = active.get(id)
      if (!running) return
      if (running.committing) fail('TRANSFER_FINALIZING')
      running.controller.abort(new Error('CANCELLED'))
      await running.done
    },
    getJob(id, ownerId) { const job = jobs.get(id); return job?.ownerId === ownerId ? { ...job } : null },
    listJobs(ownerId) { return [...jobs.values()].filter(job => job.ownerId === ownerId).map(job => ({ ...job })) },
    dispose() { disposed = true; for (const running of active.values()) if (!running.committing) running.controller.abort(new Error('CANCELLED')) },
  }
}
