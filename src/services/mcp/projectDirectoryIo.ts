import { Worker } from 'node:worker_threads'
import { projectRootFunctions } from '../../utils/git/projectRoot.js'
import { readNativeProjectDirectoryIdentity } from './projectDirectoryIdentity.js'

type DirectoryRead =
  | { kind: 'identity' | 'directory' | 'project'; path: string }
  | { kind: 'cliIdentity'; path: string; cliPath: string }
type DirectoryResult = { directory: string; root?: string; gitRoot?: string | null }
type Job = {
  id: number
  request: DirectoryRead
  timer: ReturnType<typeof setTimeout>
  resolve: (result: DirectoryResult) => void
  reject: (error: Error) => void
}
type Slot = { worker: Worker; job?: Job; retiring: boolean }

const MAX_WORKERS = 2
const MAX_QUEUED = 16
const DIRECTORY_TIMEOUT_MS = 2_000
const slots = new Set<Slot>()
const waiting: Job[] = []
let nextId = 0
let timeoutMs = DIRECTORY_TIMEOUT_MS
let createWorker = (script: string) => new Worker(script, { eval: true })

export class ProjectDirectoryIoError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'busy' | 'failed',
    message: string,
    public readonly reason?: 'missing' | 'not-directory',
  ) { super(message) }
}

/** Inline source survives bun --compile without a separately packaged worker.
 * All target-path I/O is synchronous inside a dedicated thread: stalled native
 * calls cannot occupy the API event loop or its shared async filesystem pool. */
function directoryWorkerScript(): string {
  return `
    const { parentPort } = require('node:worker_threads');
    const fs = require('node:fs');
    const paths = require('node:path');
    const readIdentity = (${readNativeProjectDirectoryIdentity.toString()});
    ${projectRootFunctions()}
    parentPort.on('message', ({ id, request }) => {
      try {
        const identity = readIdentity(request.path, fs, paths);
        const directory = identity.directory;
        if (request.kind !== 'identity') fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK);
        let root, gitRoot;
        if (request.kind === 'project') {
          gitRoot = findNativeGitRoot(directory, fs, paths).root;
          root = gitRoot ? readIdentity(resolveCanonicalNativeGitRoot(gitRoot, fs, paths), fs, paths).directory : directory;
        }
        if (request.kind === 'cliIdentity') {
          const selected = fs.statSync(directory, { bigint: true });
          const consumed = fs.statSync(request.cliPath, { bigint: true });
          if (!selected.isDirectory() || !consumed.isDirectory() || selected.ino === 0n ||
              selected.dev !== consumed.dev || selected.ino !== consumed.ino) {
            throw new Error('Project CLI directory identity could not be verified');
          }
        }
        parentPort.postMessage({ id, result: { directory, root, gitRoot } });
      } catch (error) {
        parentPort.postMessage({ id, error: error.message === 'Project directory identity could not be verified'
          ? error.message : 'Project directory is unavailable',
          reason: error.code === 'ENOENT' ? 'missing' : error.code === 'ENOTDIR' ? 'not-directory' : undefined });
      }
    });
  `
}

function settle(job: Job, error?: Error, result?: DirectoryResult): void {
  clearTimeout(job.timer)
  if (error) job.reject(error)
  else job.resolve(result!)
}

function retire(slot: Slot, error: Error): void {
  if (slot.retiring) return
  slot.retiring = true
  if (slot.job) { settle(slot.job, error); slot.job = undefined }
  slot.worker.unref()
  // terminate cannot interrupt every native syscall. Keep the slot until its
  // termination actually completes; never replace stuck threads without bound.
  try {
    void slot.worker.terminate().catch(() => {})
  } catch { /* A thread whose exit is unproven continues to consume capacity. */ }
}

function newSlot(): Slot {
  const worker = createWorker(directoryWorkerScript())
  const slot: Slot = { worker, retiring: false }
  slots.add(slot)
  worker.on('message', (message: { id: number; result?: DirectoryResult; error?: string; reason?: 'missing' | 'not-directory' }) => {
    if (slot.retiring || slot.job?.id !== message.id) return
    const job = slot.job
    slot.job = undefined
    worker.unref()
    settle(job, message.error ? new ProjectDirectoryIoError('failed', message.error, message.reason) : undefined, message.result)
    pump()
  })
  worker.on('error', () => { retire(slot, new ProjectDirectoryIoError('failed', 'Project directory is unavailable')) })
  worker.on('exit', () => {
    if (!slot.retiring && slot.job) settle(slot.job, new ProjectDirectoryIoError('failed', 'Project directory is unavailable'))
    slots.delete(slot)
    pump()
  })
  return slot
}

function pump(): void {
  while (waiting.length) {
    let slot = [...slots].find(candidate => !candidate.retiring && !candidate.job)
    if (!slot && slots.size >= MAX_WORKERS) return
    const job = waiting.shift()!
    try {
      slot ??= newSlot()
      slot.job = job
      slot.worker.ref()
      slot.worker.postMessage({ id: job.id, request: job.request })
    } catch {
      const error = new ProjectDirectoryIoError('failed', 'Project directory is unavailable')
      if (slot) retire(slot, error)
      else settle(job, error)
    }
  }
}

/** Deadline includes queueing. A timed-out read can never later grant access. */
export function readProjectDirectory(request: DirectoryRead): Promise<DirectoryResult> {
  if (waiting.length >= MAX_QUEUED) return Promise.reject(new ProjectDirectoryIoError('busy', 'Project directory checks are busy; retry shortly'))
  return new Promise((resolve, reject) => {
    const job: Job = { id: ++nextId, request, resolve, reject, timer: setTimeout(() => {
      const error = new ProjectDirectoryIoError('timeout', 'Project directory access timed out; check folder access and retry')
      const index = waiting.indexOf(job)
      if (index >= 0) { waiting.splice(index, 1); settle(job, error); return }
      const slot = [...slots].find(candidate => candidate.job === job)
      if (slot) retire(slot, error)
    }, timeoutMs) }
    waiting.push(job)
    pump()
  })
}

export async function setProjectDirectoryWorkerFactoryForTests(factory?: (script: string) => Worker, deadlineMs = DIRECTORY_TIMEOUT_MS): Promise<void> {
  if (waiting.length || [...slots].some(slot => slot.job || slot.retiring)) throw new Error('Cannot replace active project directory workers')
  await Promise.all([...slots].map(async slot => {
    slot.retiring = true
    await slot.worker.terminate()
    slots.delete(slot)
  }))
  createWorker = factory ?? (script => new Worker(script, { eval: true }))
  timeoutMs = deadlineMs
}
