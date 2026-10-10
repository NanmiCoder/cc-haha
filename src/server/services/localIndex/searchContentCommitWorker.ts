import { Worker } from 'node:worker_threads'
import { searchContentCommitFunctions, type SearchContentSourceWrite } from './searchContentIndex.js'

type Waiter = { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }
let active = false
const waiting: Waiter[] = []

/** One cold whole-file projection/commit at a time, including direct callers
 * outside the already-serial coordinator. Pending work is also bounded. */
export async function withSearchProjectionBudget<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (active) {
    if (waiting.length >= 8) throw new Error('SEARCH_CONTENT_BUSY')
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => {} }
      waiter.abort = () => {
        const index = waiting.indexOf(waiter)
        if (index >= 0) waiting.splice(index, 1)
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      waiting.push(waiter)
      signal?.addEventListener('abort', waiter.abort, { once: true })
    })
  } else active = true
  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    return await operation()
  } finally {
    const next = waiting.shift()
    if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve() }
    else active = false
  }
}

// Per-job gate shared with the worker. The worker claims a pending job before
// taking the write lock, so a cancel that wins the claim never holds the lock.
const GATE_PENDING = 0
const GATE_COMMIT = 1
const GATE_CANCEL = 2
const GATE_CLAIMED = 3

type CommitJob = {
  id: number
  worker: Worker
  gate: Int32Array
  phase: 'queued' | 'started' | 'running'
  onStarted?: () => void
  signal?: AbortSignal
  abort: () => void
  cancelled: boolean
  failure?: unknown
  resolve: () => void
  reject: (error: unknown) => void
}

let commitWorker: Worker | null = null
let nextCommitJobId = 0
const commitJobs = new Map<number, CommitJob>()

/** Inline eval avoids an external .ts worker asset that disappears from bun
 * --compile sidecars. Only scalar metadata crosses the thread boundary.
 *
 * One long-lived worker serves every commit: Bun does not return a finished
 * Worker's native memory, so a worker per commit grew the server's footprint
 * by ~185KB for every transcript append.
 *
 * The worker opens a single in-memory connection once and ATTACHes the index
 * and the spool per job. bun:sqlite handle open/close is not safe while
 * another thread opens or closes handles (rows landed in the wrong database
 * and the process could crash), and the main thread opens per-request
 * databases at any time. ATTACH/DETACH stays inside SQLite. */
function commitWorkerScript(): string {
  return `
    const { parentPort } = require('node:worker_threads');
    const { Database } = require('bun:sqlite');
    ${searchContentCommitFunctions()}
    const connection = new Database(':memory:');
    connection.exec('PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON');
    const commitJob = job => {
      const gate = new Int32Array(job.gate);
      if (Atomics.compareExchange(gate, 0, ${GATE_PENDING}, ${GATE_CLAIMED}) !== ${GATE_PENDING}) {
        return { type: 'failed', message: 'Search commit cancelled' };
      }
      const statements = new Map();
      let attached = 0;
      let open = false;
      try {
        connection.query('ATTACH DATABASE ? AS target').run(job.databasePath); attached |= 1;
        connection.query('ATTACH DATABASE ? AS spool').run(job.spoolPath); attached |= 2;
        connection.exec('PRAGMA target.cache_size=-2048; PRAGMA target.synchronous=NORMAL; PRAGMA spool.cache_size=-512');
        // Prepared (not query-cached) so every statement is finalized before DETACH.
        const statement = sql => { if (!statements.has(sql)) statements.set(sql, connection.prepare(sql)); return statements.get(sql); };
        const writer = { run: (sql, ...args) => statement(sql).run(...args), get: (sql, ...args) => statement(sql).get(...args) };
        connection.exec('BEGIN IMMEDIATE'); open = true;
        parentPort.postMessage({ type: 'started', id: job.id });
        Atomics.wait(gate, 0, ${GATE_CLAIMED});
        if (Atomics.load(gate, 0) !== ${GATE_COMMIT}) throw new Error('Search commit cancelled');
        const documents = statement('SELECT jsonlLine, byteStart, byteLength, segmentIndex, role, messageId, timestamp, body, normalizedBody FROM spool.documents ORDER BY seq');
        applySource(writer, job.source, documents.iterate(), job.append, upsert, insert);
        connection.exec('COMMIT'); open = false;
        return { type: 'complete' };
      } catch (error) {
        if (open) { try { connection.exec('ROLLBACK'); } catch {} }
        return { type: 'failed', message: String(error?.message ?? error) };
      } finally {
        for (const prepared of statements.values()) { try { prepared.finalize(); } catch {} }
        if (attached & 2) { try { connection.exec('DETACH DATABASE spool'); } catch {} }
        if (attached & 1) { try { connection.exec('DETACH DATABASE target'); } catch {} }
      }
    };
    // Report only after DETACH: the caller deletes the spool once settled.
    parentPort.on('message', job => parentPort.postMessage({ ...commitJob(job), id: job.id }));
  `
}

export function getSearchCommitWorkerForTests(): Worker | null {
  return commitWorker
}

function settleCommitJob(job: CommitJob, error?: unknown): void {
  if (!commitJobs.delete(job.id)) return
  job.signal?.removeEventListener('abort', job.abort)
  // An idle worker must not keep the process alive; a busy one must, or a
  // caller awaiting a commit could see the process exit underneath it.
  if (![...commitJobs.values()].some(other => other.worker === job.worker)) job.worker.unref()
  if (error) job.reject(error)
  else job.resolve()
}

function retireCommitWorker(worker: Worker, error: unknown): void {
  if (commitWorker === worker) commitWorker = null
  for (const job of [...commitJobs.values()]) {
    if (job.worker === worker) settleCommitJob(job, job.failure ?? error)
  }
}

function getCommitWorker(): Worker {
  if (commitWorker) return commitWorker
  const worker = new Worker(commitWorkerScript(), { eval: true })
  commitWorker = worker
  worker.on('message', (message: { type: string; id: number; message?: string }) => {
    const job = commitJobs.get(message.id)
    if (!job || job.worker !== worker) return
    if (message.type === 'complete') settleCommitJob(job, job.failure)
    else if (message.type === 'failed') settleCommitJob(job, job.failure ?? new Error(message.message))
    else if (message.type === 'started') {
      job.phase = 'started'
      if (job.cancelled) return
      try { job.onStarted?.() } catch (error) { cancelCommitJob(job, error) }
      // onStarted may have aborted (or thrown); the gate is then already cancelled.
      if (job.cancelled) return
      job.phase = 'running'
      Atomics.store(job.gate, 0, GATE_COMMIT)
      Atomics.notify(job.gate, 0)
    }
  })
  worker.on('error', error => {
    retireCommitWorker(worker, error)
    void worker.terminate()
  })
  worker.on('exit', code => retireCommitWorker(worker, new Error(`Search commit worker exited before commit (${code})`)))
  return worker
}

function cancelCommitJob(job: CommitJob, reason: unknown): void {
  if (job.cancelled || !commitJobs.has(job.id)) return
  job.cancelled = true
  job.failure = reason
  if (job.phase === 'running') {
    // The worker is inside a synchronous write; stopping it is the only way to
    // honour the abort. terminate() cannot interrupt Atomics.wait, so every
    // other job on this worker is cancelled first: a pending one is never
    // claimed, and a claimed one (possibly holding the write lock while it
    // waits on its gate) wakes, rolls back and lets the worker go idle.
    for (const other of [...commitJobs.values()]) {
      if (other.worker !== job.worker || other === job) continue
      const restarted = new Error('Search commit worker restarted')
      if (Atomics.compareExchange(other.gate, 0, GATE_PENDING, GATE_CANCEL) === GATE_PENDING) {
        settleCommitJob(other, restarted)
        continue
      }
      other.cancelled = true
      other.failure ??= restarted
      Atomics.store(other.gate, 0, GATE_CANCEL)
      Atomics.notify(other.gate, 0)
    }
    if (commitWorker === job.worker) commitWorker = null
    void job.worker.terminate()
    return
  }
  if (Atomics.compareExchange(job.gate, 0, GATE_PENDING, GATE_CANCEL) === GATE_PENDING) {
    // The worker never claimed the job, so it never took the write lock.
    settleCommitJob(job, reason)
    return
  }
  // Claimed: the worker holds (or is taking) the write lock. It rolls back and
  // reports, and the caller settles only then.
  Atomics.store(job.gate, 0, GATE_CANCEL)
  Atomics.notify(job.gate, 0)
}

export function commitSearchContentSpool(options: {
  databasePath: string
  spoolPath: string
  source: SearchContentSourceWrite
  append: boolean
  signal?: AbortSignal
  onStarted?: () => void
}): Promise<void> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise<void>((resolve, reject) => {
    const worker = getCommitWorker()
    const gate = new Int32Array(new SharedArrayBuffer(4))
    const job: CommitJob = {
      id: nextCommitJobId++,
      worker,
      gate,
      phase: 'queued',
      onStarted: options.onStarted,
      signal: options.signal,
      abort: () => cancelCommitJob(job, options.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
      cancelled: false,
      resolve,
      reject,
    }
    commitJobs.set(job.id, job)
    worker.ref()
    options.signal?.addEventListener('abort', job.abort, { once: true })
    worker.postMessage({
      id: job.id,
      databasePath: options.databasePath,
      spoolPath: options.spoolPath,
      source: options.source,
      append: options.append,
      gate: gate.buffer,
    })
  })
}
