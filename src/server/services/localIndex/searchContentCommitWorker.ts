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

/** Inline eval avoids an external .ts worker asset that disappears from bun
 * --compile sidecars. Only scalar metadata crosses the thread boundary. */
export function commitSearchContentSpool(options: {
  databasePath: string
  spoolPath: string
  source: SearchContentSourceWrite
  append: boolean
  signal?: AbortSignal
  onStarted?: () => void
}): Promise<void> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'))
  const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { Database } = require('bun:sqlite');
    ${searchContentCommitFunctions()}
    let database, spool;
    try {
      database = new Database(workerData.databasePath);
      database.exec('PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON; PRAGMA cache_size=-2048; PRAGMA synchronous=NORMAL');
      spool = new Database(workerData.spoolPath, { readonly: true });
      spool.exec('PRAGMA cache_size=-512');
      const statements = new Map();
      const statement = sql => { if (!statements.has(sql)) statements.set(sql, database.query(sql)); return statements.get(sql); };
      const writer = { run: (sql, ...args) => statement(sql).run(...args), get: (sql, ...args) => statement(sql).get(...args) };
      database.exec('BEGIN IMMEDIATE');
      parentPort.postMessage({ type: 'started' });
      const gate = new Int32Array(workerData.gate);
      Atomics.wait(gate, 0, 0);
      if (Atomics.load(gate, 0) !== 1) throw new Error('Search commit cancelled');
      applySource(writer, workerData.source, spool.query('SELECT jsonlLine, byteStart, byteLength, segmentIndex, role, messageId, timestamp, body, normalizedBody FROM documents ORDER BY seq').iterate(), workerData.append, upsert, insert);
      database.exec('COMMIT');
      database.close(); database = undefined;
      spool.close(); spool = undefined;
      parentPort.postMessage({ type: 'complete' });
    } catch (error) {
      try { database?.exec('ROLLBACK'); } catch {}
      parentPort.postMessage({ type: 'failed', message: String(error?.message ?? error) });
    } finally {
      database?.close(); spool?.close(); parentPort.close();
    }
  `
  return new Promise<void>((resolve, reject) => {
    const gate = new Int32Array(new SharedArrayBuffer(4))
    const worker = new Worker(script, { eval: true, workerData: {
      databasePath: options.databasePath, spoolPath: options.spoolPath, source: options.source, append: options.append, gate: gate.buffer,
    } })
    let completed = false
    let failure: unknown
    const abort = () => { failure = options.signal?.reason ?? new DOMException('Aborted', 'AbortError'); Atomics.store(gate, 0, 2); Atomics.notify(gate, 0); void worker.terminate() }
    options.signal?.addEventListener('abort', abort, { once: true })
    worker.on('message', message => {
      if (message.type === 'complete') completed = true
      else if (message.type === 'failed') failure = new Error(message.message)
      else if (message.type === 'started') {
        try { options.onStarted?.() } catch (error) { failure = error; Atomics.store(gate, 0, 2); Atomics.notify(gate, 0); void worker.terminate() }
        if (!failure) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0) }
      }
    })
    worker.on('error', error => { failure = error })
    worker.on('exit', code => {
      options.signal?.removeEventListener('abort', abort)
      if (failure || !completed || code !== 0) reject(failure ?? new Error(`Search commit worker exited before commit (${code})`))
      else resolve()
    })
    if (options.signal?.aborted) abort()
  })
}
