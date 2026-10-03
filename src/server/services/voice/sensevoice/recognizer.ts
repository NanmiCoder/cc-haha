/**
 * Server-side owner of the SenseVoice worker process: starts it on demand,
 * serializes requests, recycles it when idle, and kills it whenever a request
 * is cancelled, times out or the worker dies so the next request starts clean.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { isInBundledMode } from '../../../../utils/bundledMode.js'
import { VoiceServiceError } from '../errors.js'
import type { VoiceTranscript } from '../types.js'
import {
  WORKER_CONFIG_ENV,
  WORKER_TOKEN_ENV,
  type WorkerConfig,
  type WorkerErrorBody,
  type WorkerTranscript,
} from './protocol.js'

export interface SpawnWorkerInput {
  env: Record<string, string>
  cwd: string
}
export type SpawnWorker = (input: SpawnWorkerInput) => ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams>

export interface RecognizerOptions {
  /** Resolved lazily at spawn time so a freshly installed runtime is picked up. */
  workerConfig: () => WorkerConfig | Promise<WorkerConfig>
  cwd: string
  spawnWorker?: SpawnWorker
  /** Idle time before the worker is stopped; 0 keeps it warm. Default 300000. */
  idleTimeoutMs?: number
  /** Time allowed for a cold start including model load. Default 60000. */
  startupTimeoutMs?: number
  /** Time allowed for one inference. Default 120000. */
  inferenceTimeoutMs?: number
  /** Running plus waiting requests. Default 4. */
  maxPending?: number
  /** Wait between SIGTERM and SIGKILL. Default 1000. */
  killGraceMs?: number
}

interface RunningWorker {
  child: ChildProcessWithoutNullStreams
  port: number
  token: string
  closed: boolean
  stderr: string
}

const READY_LIMIT_BYTES = 4096
const RESPONSE_LIMIT_BYTES = 128 * 1024

/**
 * True inside a `bun build --compile` executable, whose modules live in a virtual
 * file system (`/$bunfs/...` on POSIX, `B:/~BUN/...` on Windows).
 */
export function isBundledWorkerHost(moduleUrl: string = import.meta.url, bundledMode: boolean = isInBundledMode()): boolean {
  if (bundledMode) return true
  try {
    const url = new URL(moduleUrl)
    // Windows Bun encodes ~BUN as %7EBUN, even when embeddedFiles is empty.
    const modulePath = decodeURIComponent(url.pathname)
    return url.protocol === 'file:' && (modulePath.startsWith('/$bunfs/') || /^\/[A-Za-z]:\/~BUN\//.test(modulePath))
  } catch {
    return false
  }
}

/**
 * Launch command for the worker. A compiled desktop binary re-runs itself with
 * `--voice-worker`; from source we run the worker entry with the current Bun.
 */
export async function defaultSpawnWorker({ env, cwd }: SpawnWorkerInput): Promise<ChildProcessWithoutNullStreams> {
  const executable = await realpath(process.execPath)
  const args = isBundledWorkerHost()
    ? ['--voice-worker']
    : ['--no-env-file', fileURLToPath(new URL('./workerMain.ts', import.meta.url))]
  return spawn(executable, args, {
    cwd,
    env,
    stdio: 'pipe',
    windowsHide: true,
  })
}

/** Minimal environment for the worker: no inherited secrets, no proxy variables. */
export function workerEnvironment(extra: Record<string, string>): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH']
  const env: Record<string, string> = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return { ...env, BUN_OPTIONS: '--no-env-file', ...extra }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Speech recognition cancelled')
}

/** Resolves with the promise result, or rejects as soon as the signal aborts. */
function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

class WorkerCallError extends Error {
  constructor(message: string, readonly invalidInput = false) {
    super(message)
  }
}

function postWav(
  worker: RunningWorker,
  wav: Uint8Array,
  language: string,
  signal: AbortSignal,
): Promise<WorkerTranscript> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: worker.port,
      method: 'POST',
      path: `/transcribe?language=${encodeURIComponent(language)}`,
      headers: {
        authorization: `Bearer ${worker.token}`,
        'content-type': 'audio/wav',
        'content-length': String(wav.byteLength),
      },
      // Loopback only: never route through an environment proxy.
      agent: false,
    }, response => {
      const chunks: Buffer[] = []
      let length = 0
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > RESPONSE_LIMIT_BYTES) {
          response.destroy(new WorkerCallError('Speech worker response exceeded its size limit'))
          return
        }
        chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => {
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          reject(new WorkerCallError('Speech worker returned malformed output'))
          return
        }
        if (response.statusCode === 200) {
          const value = body as Partial<WorkerTranscript>
          if (typeof value.text === 'string' && typeof value.audioSeconds === 'number' && typeof value.inferenceSeconds === 'number') {
            resolve({ text: value.text, audioSeconds: value.audioSeconds, inferenceSeconds: value.inferenceSeconds })
          } else {
            reject(new WorkerCallError('Speech worker returned an unexpected response'))
          }
          return
        }
        const failure = body as Partial<WorkerErrorBody>
        reject(new WorkerCallError(
          failure.error ?? `Speech worker responded ${response.statusCode}`,
          failure.code === 'invalid-input' && (response.statusCode === 400 || response.statusCode === 413),
        ))
      })
    })
    // Bun's http.request ignores the `signal` option, so cancellation is wired by hand.
    // A destroyed request emits only 'close'; settle it there (a no-op if already settled).
    const onAbort = (): void => {
      req.destroy()
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    req.once('error', error => {
      cleanup()
      reject(signal.aborted ? abortReason(signal) : error)
    })
    req.once('close', () => {
      cleanup()
      setImmediate(() => reject(signal.aborted ? abortReason(signal) : new WorkerCallError('Speech worker closed the connection')))
    })
    if (signal.aborted) {
      req.destroy()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
      req.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength))
    }
  })
}

export class SenseVoiceRecognizer {
  private worker: RunningWorker | undefined
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private idle: ReturnType<typeof setTimeout> | undefined
  private readonly lifetime = new AbortController()
  private readonly idleTimeoutMs: number
  private readonly startupTimeoutMs: number
  private readonly inferenceTimeoutMs: number
  private readonly maxPending: number
  private readonly killGraceMs: number
  private readonly spawnWorker: SpawnWorker

  constructor(private readonly options: RecognizerOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000
    this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000
    this.inferenceTimeoutMs = options.inferenceTimeoutMs ?? 120_000
    this.maxPending = options.maxPending ?? 4
    this.killGraceMs = options.killGraceMs ?? 1000
    this.spawnWorker = options.spawnWorker ?? defaultSpawnWorker
  }

  /** True while a worker process is alive. */
  get running(): boolean {
    return this.worker !== undefined && !this.worker.closed
  }

  transcribe(wav: Uint8Array, language: string, signal: AbortSignal): Promise<VoiceTranscript> {
    return this.enqueue(async combined => this.execute(wav, language, combined), signal)
  }

  private enqueue<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    if (combined.aborted) return Promise.reject(abortReason(combined))
    if (this.pending >= this.maxPending) {
      return Promise.reject(new VoiceServiceError('voice/failed', 'Speech transcription queue is full'))
    }
    clearTimeout(this.idle)
    this.pending++
    const job = this.tail.then(async () => {
      combined.throwIfAborted()
      return await run(combined)
    })
    this.tail = job.then(() => undefined, () => undefined).finally(() => {
      this.pending--
      if (this.pending === 0 && !this.lifetime.signal.aborted && this.idleTimeoutMs > 0) {
        this.idle = setTimeout(() => {
          this.tail = this.tail.then(async () => {
            if (this.pending === 0) await this.stopWorker()
          })
        }, this.idleTimeoutMs)
        this.idle.unref?.()
      }
    })
    return job
  }

  private async execute(wav: Uint8Array, language: string, signal: AbortSignal): Promise<VoiceTranscript> {
    let worker: RunningWorker
    try {
      worker = await this.ensureWorker(signal)
    } catch (error) {
      await this.stopWorker()
      throw this.toServiceError(error, signal, 'start')
    }

    const call = new AbortController()
    const timer = setTimeout(() => call.abort(new Error('Speech recognition timed out')), this.inferenceTimeoutMs)
    try {
      const result = await postWav(worker, wav, language, AbortSignal.any([signal, call.signal]))
      return result
    } catch (error) {
      if (error instanceof WorkerCallError && error.invalidInput) {
        throw new VoiceServiceError('voice/invalid-audio', error.message)
      }
      // The worker's state is unknown after any other failure: start over next time.
      await this.stopWorker()
      throw this.toServiceError(error, signal, 'inference', worker.stderr)
    } finally {
      clearTimeout(timer)
    }
  }

  private toServiceError(error: unknown, signal: AbortSignal, phase: 'start' | 'inference', stderr = ''): Error {
    if (signal.aborted) return abortReason(signal)
    if (error instanceof VoiceServiceError) return error
    const detail = error instanceof Error ? error.message : String(error)
    const tail = stderr.trim() ? ` (${stderr.trim().slice(-300)})` : ''
    return new VoiceServiceError('voice/failed', `Speech recognizer ${phase === 'start' ? 'could not start' : 'failed'}: ${detail}${tail}`)
  }

  private async ensureWorker(signal: AbortSignal): Promise<RunningWorker> {
    if (this.worker && !this.worker.closed) return this.worker
    if (this.worker) await this.stopWorker()

    const config = await this.options.workerConfig()
    const token = randomBytes(32).toString('hex')
    const child = await this.spawnWorker({
      cwd: this.options.cwd,
      env: workerEnvironment({
        [WORKER_CONFIG_ENV]: JSON.stringify(config),
        [WORKER_TOKEN_ENV]: token,
      }),
    })
    const worker: RunningWorker = { child, port: 0, token, closed: false, stderr: '' }
    this.worker = worker
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { worker.stderr = (worker.stderr + chunk).slice(-4096) })
    child.stdin.on('error', () => {})
    const exited = new Promise<never>((_, reject) => {
      child.on('error', error => {
        worker.closed = true
        reject(error)
      })
      child.once('exit', (code, exitSignal) => {
        worker.closed = true
        reject(new Error(`worker exited (${exitSignal ?? code})`))
      })
    })
    exited.catch(() => {})

    const startup = new AbortController()
    const timer = setTimeout(() => startup.abort(new Error('Speech recognizer startup timed out')), this.startupTimeoutMs)
    try {
      worker.port = await raceAbort(
        Promise.race([readPort(child), exited]),
        AbortSignal.any([signal, startup.signal]),
      )
    } catch (error) {
      if (worker.stderr.trim()) {
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${worker.stderr.trim().slice(-300)}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    child.stdout.resume()
    return worker
  }

  /** Terminates the worker if one exists; the next request starts a fresh one. */
  async stopWorker(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    this.worker = undefined
    worker.closed = true
    const child = worker.child
    if (child.exitCode !== null || child.signalCode !== null) return
    const gone = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), this.killGraceMs)
    try {
      await gone
    } finally {
      clearTimeout(force)
    }
  }

  /** Stops accepting work, lets the running request settle and terminates the worker. */
  async dispose(): Promise<void> {
    clearTimeout(this.idle)
    this.lifetime.abort(new Error('Speech recognizer disposed'))
    await this.tail
    await this.stopWorker()
  }
}

function readPort(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let text = ''
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8')
      if (Buffer.byteLength(text) > READY_LIMIT_BYTES) {
        child.stdout.off('data', onData)
        reject(new Error('Speech worker readiness line is too long'))
        return
      }
      const end = text.indexOf('\n')
      if (end < 0) return
      child.stdout.off('data', onData)
      try {
        const value = JSON.parse(text.slice(0, end)) as { port?: unknown }
        if (typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0 && value.port < 65536) {
          resolve(value.port)
        } else {
          reject(new Error('Speech worker reported an invalid port'))
        }
      } catch {
        reject(new Error('Speech worker printed an invalid readiness line'))
      }
    }
    child.stdout.on('data', onData)
  })
}
