import { createHostToolsPreferences, type HostToolsPreferencesRepository } from './hostToolsPreferences.js'
import { applicationScriptCommand } from './applicationScriptCommand.js'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel, Stats } from 'ssh2'
import {
  ApplicationOperationInputSchema, isApplicationLog, isApplicationScript,
  type ApplicationFileTarget, type ApplicationOperationInput, type ApplicationOperationResult, type ApplicationOperation,
} from '../../../src/features/managed-resources/api/applicationOperationsApi.js'
import type { ManagedResourcesServices } from './registerIpc.js'
import { applicationError, applicationFileRevision, applicationPreview, APPLICATION_OUTPUT_LIMIT, fileKind, quoteShellArgument, sftpRequest } from './applicationOperationsIo.js'

type Services = Pick<ManagedResourcesServices, 'store' | 'sshService' | 'sftpService'>
type Start = Extract<ApplicationOperationInput, { action: 'start' }>
type Job = {
  ownerId: string; input: Start; binding: string; fingerprint: string
  public: ApplicationOperation; channel?: ClientChannel; expiresAt: number; startedAt: number
  stdout: StringDecoder; stderr: StringDecoder; finished: boolean
}
const absolute = (value: string) => value.startsWith('/') && value.length <= 4096 && !/[\\\x00-\x1f\x7f]/.test(value) && !value.split('/').some(x => x === '.' || x === '..')
const live = (job: Job) => job.public.state === 'starting' || job.public.state === 'running'

/** All targets are derived from stored application roots, not arbitrary renderer commands. */
export function createApplicationOperationsService(services: Services, preferences: HostToolsPreferencesRepository = createHostToolsPreferences(services.store)) {
  const jobs = new Map<string, Job>()
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  const snapshot = (job: Job): ApplicationOperationResult => ({ kind: 'operation', operation: { ...job.public } })
  const append = (job: Job, value: string) => {
    if (!live(job)) return
    job.public.text += value
    if (job.public.text.length > APPLICATION_OUTPUT_LIMIT) {
      job.public.text = job.public.text.slice(-APPLICATION_OUTPUT_LIMIT)
      job.public.truncated = true
    }
  }
  function stop(job: Job, reason?: string) {
    if (!live(job)) return
    job.public.state = reason ? 'failed' : 'stopped'
    job.public.errorCode = reason ?? null
    // Stop only this exec channel. Never close the user's terminal/shared SSH client.
    try { job.channel?.signal('TERM') } catch { /* Server may not implement signals. */ }
    try { job.channel?.close() } catch { /* Disconnected channel. */ }
    try { job.channel?.destroy() } catch { /* Disconnected channel. */ }
  }
  function connection(target: ApplicationFileTarget, ownerId: string) {
    const value = services.sshService.getInternalsForOwner(target.connectionId, ownerId)
    if (!value || value.session.hostId !== target.hostId) throw new Error('UNAUTHORIZED_OWNER')
    if (value.generation !== target.generation) throw new Error('STALE_GENERATION')
    if (value.session.status !== 'ready') throw new Error('DISCONNECTED')
    return value
  }
  async function context(target: ApplicationFileTarget, ownerId: string) {
    connection(target, ownerId)
    const loaded = await services.store.load()
    if (loaded.status !== 'ready') throw new Error('RESOURCE_NOT_FOUND')
    const host = loaded.document.hosts.find(h => h.id === target.hostId)
    const app = host?.applications.find(a => a.id === target.applicationId)
    const stored = app?.installPaths[target.rootIndex]
    if (!stored || !absolute(stored)) throw new Error('INVALID_REMOTE_PATH')
    const root = path.posix.normalize(stored)
    const base = path.posix.join(root, target.directory)
    const filename = path.posix.join(base, target.relativePath)
    if (filename !== base && !filename.startsWith(base + '/')) throw new Error('INVALID_REMOTE_PATH')
    connection(target, ownerId)
    return { filename, binding: `${target.applicationId}:${target.rootIndex}:${root}`, base, storedRoot: stored }
  }
  async function checkedFile(target: ApplicationFileTarget, ownerId: string) {
    const ctx = await context(target, ownerId)
    const { sftp } = await services.sftpService.ensureSftp(target.connectionId, ownerId)
    let current = ''
    let attrs!: Stats
    // lstat every parent too: symlinked descendants must not escape the application's root.
    for (const part of ctx.filename.split('/').filter(Boolean)) {
      current += '/' + part
      attrs = await sftpRequest<Stats>(done => sftp.lstat(current, done))
      if (fileKind(attrs.mode) === 'symlink') throw new Error('IS_SYMLINK')
      if (current !== ctx.filename && fileKind(attrs.mode) !== 'directory') throw new Error('NOT_A_DIRECTORY')
    }
    connection(target, ownerId)
    return { ...ctx, sftp, attrs }
  }
  const regular = (attrs: Stats) => { if (fileKind(attrs.mode) !== 'file') throw new Error('NOT_A_FILE') }
  function maintenance() {
    for (const job of jobs.values()) if (live(job)) {
      try {
        connection(job.input, job.ownerId)
        if (Date.now() > job.expiresAt || Date.now() - job.startedAt > 30 * 60_000) throw new Error('OPERATION_TIMEOUT')
      } catch (error) { stop(job, applicationError(error)) }
    }
    if (![...jobs.values()].some(live) && timer) { clearInterval(timer); timer = undefined }
  }
  function owned(id: string, ownerId: string) {
    const job = jobs.get(id)
    if (!job) throw new Error('RESOURCE_NOT_FOUND')
    if (job.ownerId !== ownerId) throw new Error('UNAUTHORIZED_OWNER')
    return job
  }
  async function launch(job: Job) {
    try {
      const target = await checkedFile(job.input, job.ownerId)
      regular(target.attrs)
      if (!live(job) || disposed) return
      // Log growth is expected between listing and Tail; only execution needs an unchanged confirmation.
      if (job.input.mode === 'script' && applicationFileRevision(target.attrs) !== job.input.expectedRevision) throw new Error('REVISION_CONFLICT')
      const filename = path.posix.basename(target.filename)
      if (job.input.mode === 'script' ? !isApplicationScript(filename) : !isApplicationLog(filename)) throw new Error('INVALID_ARGUMENT')
      job.binding = target.binding
      job.public.absolutePath = target.filename
      job.public.cwd = path.posix.dirname(target.filename)
      const preferenceScope = { hostId: job.input.hostId, applicationId: job.input.applicationId, rootIndex: job.input.rootIndex, expectedRoot: target.storedRoot }
      const runAsUser = job.input.mode === 'script' ? (await preferences.get(preferenceScope)).runAsUser : ''
      if (job.input.mode === 'script' && runAsUser !== (job.input.expectedRunAsUser ?? '')) throw new Error('RUN_AS_CHANGED')
      const command = job.input.mode === 'script'
        ? applicationScriptCommand(job.public.cwd, filename, runAsUser)
        : `exec tail -n 200 -F -- ${quoteShellArgument(target.filename)}`
      if ((await context(job.input, job.ownerId)).binding !== job.binding) throw new Error('APPLICATION_CHANGED')
      if (!live(job) || disposed) return
      if (job.input.mode === 'script' && (await preferences.get(preferenceScope)).runAsUser !== runAsUser) throw new Error('RUN_AS_CHANGED')
      if (!live(job) || disposed) return
      const { client } = connection(job.input, job.ownerId)
      // Exactly one exec per request id; poll never starts or replays a command.
      client.exec(command, (error, channel) => {
        if (error) { stop(job, applicationError(error)); return }
        if (!live(job) || disposed) { try { channel.signal('TERM'); channel.close() } catch { channel.destroy() }; return }
        job.channel = channel
        job.public.state = 'running'
        channel.on('data', (data: Buffer) => append(job, job.stdout.write(data)))
        channel.stderr.on('data', (data: Buffer) => append(job, job.stderr.write(data)))
        channel.on('error', (error: Error) => stop(job, applicationError(error)))
        channel.stderr.on('error', (error: Error) => stop(job, applicationError(error)))
        // This operation has no interactive input UI. EOF prevents su/PAM or a
        // script from waiting for a password that the application will never collect.
        if (job.input.mode === 'script') channel.end()
        channel.once('exit', (code: number | null, signal?: string) => {
          job.public.exitCode = typeof code === 'number' ? code : null
          job.public.signal = signal ?? null
        })
        channel.once('close', () => {
          if (!live(job)) return
          append(job, job.stdout.end() + job.stderr.end())
          job.finished = true
          job.public.state = job.public.exitCode === 0 ? 'completed' : 'failed'
          job.public.errorCode = job.public.exitCode === null ? 'EXIT_STATUS_UNKNOWN' : job.public.exitCode === 0 ? null : 'SCRIPT_EXIT_FAILED'
        })
      })
    } catch (error) { stop(job, applicationError(error)) }
  }
  return {
    async perform(raw: ApplicationOperationInput, ownerId: string): Promise<ApplicationOperationResult> {
      if (disposed) throw new Error('DISCONNECTED')
      const input = ApplicationOperationInputSchema.parse(raw)
      if (input.action === 'poll' || input.action === 'stop') {
        const job = owned(input.operationId, ownerId)
        if (input.action === 'stop') stop(job)
        else if (live(job)) {
          try {
            const ctx = await context(job.input, ownerId)
            if (job.binding && ctx.binding !== job.binding) throw new Error('APPLICATION_CHANGED')
            job.expiresAt = Date.now() + 15_000
          } catch (error) { stop(job, applicationError(error)) }
        }
        return snapshot(job)
      }
      if (input.action === 'start') {
        const fingerprint = JSON.stringify({ ...input, ownerId })
        const previous = jobs.get(input.requestId)
        if (previous) {
          if (previous.ownerId !== ownerId) throw new Error('UNAUTHORIZED_OWNER')
          if (previous.fingerprint !== fingerprint) throw new Error('REQUEST_ID_CONFLICT')
          return snapshot(previous)
        }
        // Retain request tombstones instead of silently replaying an evicted script id.
        if (jobs.size >= 128 || [...jobs.values()].filter(live).length >= 8) throw new Error('OPERATION_LIMIT')
        const job: Job = {
          ownerId, input, fingerprint, binding: '', expiresAt: Date.now() + 15_000, startedAt: Date.now(),
          stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8'), finished: false,
          public: { id: input.requestId, mode: input.mode, absolutePath: '', cwd: '', state: 'starting', text: '', truncated: false, exitCode: null, signal: null, errorCode: null },
        }
        jobs.set(job.public.id, job)
        if (!timer) { timer = setInterval(maintenance, 1000); timer.unref?.() }
        void launch(job)
        return snapshot(job)
      }
      const ctx = await checkedFile(input, ownerId)
      if (input.action === 'list') {
        if (fileKind(ctx.attrs.mode) !== 'directory') throw new Error('NOT_A_DIRECTORY')
        const items = await sftpRequest<Array<{ filename: string; attrs: Stats }>>(done => ctx.sftp.readdir(ctx.filename, done))
        if (items.length > 10_000) throw new Error('DIRECTORY_LIMIT')
        connection(input, ownerId)
        const entries = items.filter(item => item.filename !== '.' && item.filename !== '..').map(item => {
          if (!item.filename || /[\/\\\x00-\x1f\x7f]/.test(item.filename)) throw new Error('INVALID_REMOTE_PATH')
          return { name: item.filename, relativePath: [input.relativePath, item.filename].filter(Boolean).join('/'), absolutePath: path.posix.join(ctx.filename, item.filename), type: fileKind(item.attrs.mode), size: item.attrs.size, revision: applicationFileRevision(item.attrs) }
        })
        entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name))
        return { kind: 'files', absolutePath: ctx.filename, entries }
      }
      regular(ctx.attrs)
      if (input.action === 'read') {
        const value = await applicationPreview(ctx.sftp, ctx.filename, ctx.attrs.size)
        connection(input, ownerId)
        return { kind: 'content', absolutePath: ctx.filename, ...value }
      }
      if (!isApplicationLog(ctx.filename)) throw new Error('INVALID_ARGUMENT')
      if (applicationFileRevision(ctx.attrs) !== input.expectedRevision) throw new Error('REVISION_CONFLICT')
      if ((await context(input, ownerId)).binding !== ctx.binding) throw new Error('APPLICATION_CHANGED')
      connection(input, ownerId)
      await sftpRequest<void>(done => ctx.sftp.unlink(ctx.filename, done))
      return { kind: 'deleted' }
    },
    dispose() { disposed = true; if (timer) clearInterval(timer); for (const job of jobs.values()) stop(job); jobs.clear() },
  }
}
