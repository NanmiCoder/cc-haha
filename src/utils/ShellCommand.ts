import type { ChildProcess } from 'child_process'
import { stat } from 'fs/promises'
import type { Readable } from 'stream'
import treeKill from 'tree-kill'
import { generateTaskId } from '../Task.js'
import { formatDuration } from './format.js'
import { probeProcessState } from './genericProcessUtils.js'
import {
  MAX_TASK_OUTPUT_BYTES,
  MAX_TASK_OUTPUT_BYTES_DISPLAY,
} from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'

export type ExecResult = {
  stdout: string
  stderr: string
  code?: number
  interrupted: boolean
  outcomeKnown?: boolean
  processObservation?: 'alive' | 'dead' | 'unknown'
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  /** Set when assistant-mode auto-backgrounded a long-running blocking command. */
  assistantAutoBackgrounded?: boolean
  /** Set when stdout was too large to fit inline — points to the output file on disk. */
  outputFilePath?: string
  /** Why termination was requested, when applicable. */
  terminationReason?: 'timeout' | 'user' | 'abort' | 'output_limit'
  /** Whether termination was not confirmed within the bounded wait. */
  terminationFailure?: boolean
  /** Total size of the output file in bytes (set when outputFilePath is set). */
  outputFileSize?: number
  /** The task ID for the output file (set when outputFilePath is set). */
  outputTaskId?: string
  /** Error message when the command failed before spawning (e.g., deleted cwd). */
  preSpawnError?: string
}

export type ShellCommand = {
  background: (backgroundTaskId: string) => boolean
  result: Promise<ExecResult>
  /** Resolves only when the process lifecycle actually ends. */
  completion?: Promise<ExecResult>
  /** Resolves when a timeout termination attempt fails before process exit. */
  terminationFailureResult?: Promise<ExecResult>
  /** Requests termination; completion is reported only after process exit. */
  kill: () => void
  /** Waits for a real process exit or an OS-confirmed process disappearance. */
  waitForExit: (timeoutMs: number) => Promise<boolean>
  /** Requests termination and waits for bounded confirmation. */
  terminateAndWait: (
    timeoutMs: number,
    reason?: ShellCommand['terminationReason'],
  ) => Promise<boolean>
  /** Settles the command with an unknown outcome after the OS confirms its PID is gone. */
  confirmProcessDisappeared: () => boolean
  status: 'running' | 'backgrounded' | 'completed' | 'killed'
  /** OS PID of the wrapped process, when it was spawned. */
  pid: number | undefined
  terminationRequested: boolean
  terminationConfirmed: boolean
  terminationReason?: 'timeout' | 'user' | 'abort' | 'output_limit'
  /** Whether the wrapped process has exited or was confirmed dead by OS probing. */
  processExited: boolean
  /**
   * Cleans up stream resources (event listeners).
   * Should be called after the command completes or is killed to prevent memory leaks.
   */
  cleanup: () => void
  onTimeout?: (
    callback: (backgroundFn: (taskId: string) => boolean) => void,
  ) => void
  /** The TaskOutput instance that owns all stdout/stderr data and progress. */
  taskOutput: TaskOutput
}

const SIGKILL = 137
const SIGTERM = 143

// Background tasks write stdout/stderr directly to a file fd (no JS involvement),
// so a stuck append loop can fill the disk. Poll file size and kill when exceeded.
const SIZE_WATCHDOG_INTERVAL_MS = 5_000

/** Windows has no SIGKILL, so the hard-kill fallback uses SIGTERM. */
const DEFAULT_KILL_CODE = process.platform === 'win32' ? SIGTERM : SIGKILL

// After a ChildProcess 'error' with a valid PID, probe the OS process tree
// every ERROR_PROBE_INTERVAL_MS until it is confirmed dead. The result promise
// only settles on a real exit or an OS-confirmed dead process — a live process
// must never be reported as exited.
const ERROR_PROBE_INTERVAL_MS = 1_000
const TERMINATION_WAIT_MS = 5_000

export type ShellProcessControl = {
  probe: typeof probeProcessState
  killGroup: typeof killDetachedProcessGroup
  killTree: (pid: number, callback: (error?: Error) => void) => void
  platform?: NodeJS.Platform
}

const defaultShellProcessControl: ShellProcessControl = {
  probe: probeProcessState,
  killGroup: killDetachedProcessGroup,
  killTree: (pid, callback) => treeKill(pid, 'SIGKILL', callback),
  platform: process.platform,
}

export function killDetachedProcessGroup(pid: number): boolean {
  if (process.platform === 'win32') {
    return false
  }

  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

function prependStderr(prefix: string, stderr: string): string {
  return stderr ? `${prefix} ${stderr}` : prefix
}

/**
 * Thin pipe from a child process stream into TaskOutput.
 * Used in pipe mode (hooks) for stdout and stderr.
 * In file mode (bash commands), both fds go to the output file —
 * the child process streams are null and no wrappers are created.
 */
class StreamWrapper {
  #stream: Readable | null
  #isCleanedUp = false
  #taskOutput: TaskOutput | null
  #isStderr: boolean
  #onData = this.#dataHandler.bind(this)

  constructor(stream: Readable, taskOutput: TaskOutput, isStderr: boolean) {
    this.#stream = stream
    this.#taskOutput = taskOutput
    this.#isStderr = isStderr
    // Emit strings instead of Buffers - avoids repeated .toString() calls
    stream.setEncoding('utf-8')
    stream.on('data', this.#onData)
  }

  #dataHandler(data: Buffer | string): void {
    const str = typeof data === 'string' ? data : data.toString()

    if (this.#isStderr) {
      this.#taskOutput!.writeStderr(str)
    } else {
      this.#taskOutput!.writeStdout(str)
    }
  }

  cleanup(): void {
    if (this.#isCleanedUp) {
      return
    }
    this.#isCleanedUp = true
    this.#stream!.removeListener('data', this.#onData)
    // Release references so the stream, its StringDecoder, and
    // the TaskOutput can be GC'd independently of this wrapper.
    this.#stream = null
    this.#taskOutput = null
    this.#onData = () => {}
  }
}

/**
 * Implementation of ShellCommand that wraps a child process.
 *
 * For bash commands: both stdout and stderr go to a file fd via
 * stdio[1] and stdio[2] — no JS involvement. Progress is extracted
 * by polling the file tail.
 * For hooks: pipe mode with StreamWrappers for real-time detection.
 */
type TerminationAttempt = {
  generation: number
  reason: NonNullable<ShellCommand['terminationReason']>
  dispatched: boolean
  active: boolean
  dispatch: 'pending' | 'succeeded' | 'failed'
  exit?: { code: number | null; signal: NodeJS.Signals | null; disappeared?: boolean }
  dispatchSettled: Promise<void>
  settleDispatch: () => void
  dispatchTimer?: NodeJS.Timeout
}

class ShellCommandImpl implements ShellCommand {
  #status: 'running' | 'backgrounded' | 'completed' | 'killed' = 'running'
  #terminationRequested = false
  #terminationCode: number | undefined
  #processExited = false
  #exitWaiters = new Set<() => void>()
  #backgroundTaskId: string | undefined
  #stdoutWrapper: StreamWrapper | null
  #stderrWrapper: StreamWrapper | null
  #childProcess: ChildProcess | null
  readonly #pid: number | undefined
  #terminationGeneration = 0
  #terminationAttempt: TerminationAttempt | null = null
  #terminationConfirmed = false
  #terminationFailure = false
  #terminationFailureResolver: ((result: ExecResult) => void) | null = null
  #timeoutId: NodeJS.Timeout | null = null
  // Independent of #cleanupListeners() — probing must keep running even after
  // background() tears down the timeout/size listeners, otherwise an error'd
  // child that never exits would leave the result pending forever.
  #errorProbeTimer: ReturnType<typeof setInterval> | null = null
  #sizeWatchdog: NodeJS.Timeout | null = null
  #killedForSize = false
  // Set when an 'error' fires after a successful spawn; used to keep a
  // SIGTERM-labeled exit from being misreported as a command timeout.
  #hadErrorAfterSpawn = false
  #maxOutputBytes: number
  #processControl: ShellProcessControl
  #abortSignal: AbortSignal
  #onTimeoutCallback:
    | ((backgroundFn: (taskId: string) => boolean) => void)
    | undefined
  #timeout: number
  #shouldAutoBackground: boolean
  #resultResolver: ((result: ExecResult) => void) | null = null
  #exitCodeResolver: ((code?: number) => void) | null = null
  #boundAbortHandler: (() => void) | null = null
  readonly taskOutput: TaskOutput

  static #handleTimeout(self: ShellCommandImpl): void {
    if (self.#shouldAutoBackground && self.#onTimeoutCallback) {
      self.#onTimeoutCallback(self.background.bind(self))
    } else {
      void self.terminateAndWait(TERMINATION_WAIT_MS, 'timeout')
    }
  }

  readonly result: Promise<ExecResult>
  readonly completion: Promise<ExecResult>
  readonly terminationFailureResult: Promise<ExecResult>
  #completionResolver!: (result: ExecResult) => void
  readonly onTimeout?: (
    callback: (backgroundFn: (taskId: string) => boolean) => void,
  ) => void

  constructor(
    childProcess: ChildProcess,
    abortSignal: AbortSignal,
    timeout: number,
    taskOutput: TaskOutput,
    shouldAutoBackground = false,
    maxOutputBytes = MAX_TASK_OUTPUT_BYTES,
    processControl = defaultShellProcessControl,
  ) {
    this.#childProcess = childProcess
    this.#pid = childProcess.pid ?? undefined
    this.#abortSignal = abortSignal
    this.#timeout = timeout
    this.#shouldAutoBackground = shouldAutoBackground
    this.#maxOutputBytes = maxOutputBytes
    this.#processControl = processControl
    this.taskOutput = taskOutput

    // In file mode (bash commands), both stdout and stderr go to the
    // output file fd — childProcess.stdout/.stderr are both null.
    // In pipe mode (hooks), wrap streams to funnel data into TaskOutput.
    this.#stderrWrapper = childProcess.stderr
      ? new StreamWrapper(childProcess.stderr, taskOutput, true)
      : null
    this.#stdoutWrapper = childProcess.stdout
      ? new StreamWrapper(childProcess.stdout, taskOutput, false)
      : null

    if (shouldAutoBackground) {
      this.onTimeout = (callback): void => {
        this.#onTimeoutCallback = callback
      }
    }

    this.completion = new Promise(resolve => { this.#completionResolver = resolve })
    this.terminationFailureResult = new Promise(resolve => { this.#terminationFailureResolver = resolve })
    this.result = this.#createResultPromise()
  }

  get status(): 'running' | 'backgrounded' | 'completed' | 'killed' {
    return this.#status
  }

  get terminationRequested(): boolean {
    return this.#terminationRequested
  }

  get terminationConfirmed(): boolean {
    return this.#terminationConfirmed
  }

  get terminationFailure(): boolean {
    return this.#terminationFailure
  }

  get terminationReason(): ShellCommand['terminationReason'] {
    return this.#terminationAttempt?.reason
  }

  get processExited(): boolean {
    return this.#processExited
  }

  get pid(): number | undefined {
    return this.#pid
  }

  #abortHandler(): void {
    // On 'interrupt' (user submitted a new message), don't kill — let the
    // caller background the process so the model can see partial output.
    if (this.#abortSignal.reason === 'interrupt') {
      return
    }
    void this.terminateAndWait(TERMINATION_WAIT_MS, 'abort')
  }

  #markProcessExited(): boolean {
    if (this.#processExited) {
      return false
    }
    this.#processExited = true
    for (const resolve of this.#exitWaiters) resolve()
    this.#exitWaiters.clear()
    return true
  }

  #exitHandler(code: number | null, signal: NodeJS.Signals | null): void {
    this.#stopErrorProbe()
    const attempt = this.#terminationAttempt
    const refinesDisappearance =
      this.#processExited &&
      attempt?.active === true &&
      attempt.exit?.disappeared === true
    if (!refinesDisappearance && !this.#markProcessExited()) {
      return
    }
    const exitCode =
      code !== null && code !== undefined
        ? code
        : signal === 'SIGTERM'
          ? SIGTERM
          : signal === 'SIGKILL'
            ? SIGKILL
            : this.#terminationCode ?? 1
    if (this.#terminationRequested) {
      if (attempt?.active) {
        attempt.exit = { code, signal }
        if (this.#processControl.platform !== 'win32' && signal === null) {
          this.#markDispatchFailed(attempt)
        }
        if (attempt.dispatch !== 'pending' || !this.#pid) {
          this.#settleAttemptExit(attempt)
        }
      } else {
        this.#status = 'completed'
        this.#resolveExitCode(exitCode)
      }
    } else {
      this.#resolveExitCode(exitCode)
    }
  }

  #errorHandler(): void {
    const childProcess = this.#childProcess
    if (!childProcess) {
      return
    }
    // Spawn failures have no child PID and may not emit an exit event, so they
    // are terminal immediately.
    if (childProcess.pid === undefined || childProcess.pid === null) {
      this.#markProcessExited()
      this.#resolveExitCode(1)
      return
    }
    // A child that already has a PID may or may not emit 'exit' after 'error'
    // (Node makes no guarantee). The result must still converge, but a live
    // process must never be reported as exited: probe the OS PID until it is
    // confirmed dead, then settle. A real 'exit' event wins over the probe.
    if (!this.#errorProbeTimer) {
      this.#hadErrorAfterSpawn = true
      const check = (): void => {
        if (this.#processExited || this.#childProcess === null) {
          this.#stopErrorProbe()
          return
        }
        const pid = this.#pid
        if (pid === undefined || pid === null) {
          this.#stopErrorProbe()
          return
        }
        // Only a confirmed-dead PID may settle the result. alive / unknown
        // keep probing so a surviving process is never marked exited.
        this.confirmProcessDisappeared()
      }
      check()
      if (!this.#processExited) {
        this.#errorProbeTimer = setInterval(check, ERROR_PROBE_INTERVAL_MS)
        this.#errorProbeTimer.unref()
      }
    }
  }

  #startErrorProbe(): void {
    if (this.#errorProbeTimer) return
    const check = (): void => {
      if (this.#processExited || this.#childProcess === null) {
        this.#stopErrorProbe()
        return
      }
      this.confirmProcessDisappeared()
    }
    this.#errorProbeTimer = setInterval(check, ERROR_PROBE_INTERVAL_MS)
    this.#errorProbeTimer.unref()
  }

  #stopErrorProbe(): void {
    if (this.#errorProbeTimer) {
      clearInterval(this.#errorProbeTimer)
      this.#errorProbeTimer = null
    }
  }

  #resolveExitCode(code?: number): void {
    if (this.#exitCodeResolver) {
      this.#exitCodeResolver(code)
      this.#exitCodeResolver = null
    }
  }

  // Note: exit/error listeners are NOT removed here — they're needed for
  // the result promise to resolve. They clean up when the child process exits.
  #cleanupListeners(): void {
    this.#clearSizeWatchdog()
    // Note: #errorProbeTimer is intentionally NOT cleared here. background()
    // calls cleanupListeners() and the probe must keep running so a child that
    // error'd and never exits still converges to a confirmed-dead settlement.
    const timeoutId = this.#timeoutId
    if (timeoutId) {
      clearTimeout(timeoutId)
      this.#timeoutId = null
    }
    const boundAbortHandler = this.#boundAbortHandler
    if (boundAbortHandler) {
      this.#abortSignal.removeEventListener('abort', boundAbortHandler)
      this.#boundAbortHandler = null
    }
  }

  #clearSizeWatchdog(): void {
    if (this.#sizeWatchdog) {
      clearInterval(this.#sizeWatchdog)
      this.#sizeWatchdog = null
    }
  }

  #startSizeWatchdog(): void {
    this.#sizeWatchdog = setInterval(() => {
      void stat(this.taskOutput.path).then(
        s => {
          // Bail if the watchdog was cleared while this stat was in flight
          // (process exited on its own) — otherwise we'd mislabel stderr.
          const attempt = this.#terminationAttempt
          const terminationInProgress =
            attempt?.active === true && attempt.dispatch !== 'failed'
          if (
            s.size > this.#maxOutputBytes &&
            this.#status === 'backgrounded' &&
            this.#sizeWatchdog !== null &&
            !terminationInProgress
          ) {
            this.#clearSizeWatchdog()
            void this.terminateAndWait(TERMINATION_WAIT_MS, 'output_limit')
          }
        },
        () => {
          // ENOENT before first write, or unlinked mid-run — skip this tick
        },
      )
    }, SIZE_WATCHDOG_INTERVAL_MS)
    this.#sizeWatchdog.unref()
  }

  #createResultPromise(): Promise<ExecResult> {
    this.#boundAbortHandler = this.#abortHandler.bind(this)
    this.#abortSignal.addEventListener('abort', this.#boundAbortHandler, {
      once: true,
    })

    // Use 'exit' not 'close': 'close' waits for stdio to close, which includes
    // grandchild processes that inherit file descriptors (e.g. `sleep 30 &`).
    // 'exit' fires when the shell itself exits, returning control immediately.
    this.#childProcess!.once('exit', this.#exitHandler.bind(this))
    this.#childProcess!.once('error', this.#errorHandler.bind(this))

    this.#timeoutId = setTimeout(
      ShellCommandImpl.#handleTimeout,
      this.#timeout,
      this,
    ) as NodeJS.Timeout

    const exitPromise = new Promise<number | undefined>(resolve => {
      this.#exitCodeResolver = resolve
    })

    return new Promise<ExecResult>(resolve => {
      this.#resultResolver = resolve
      void exitPromise.then(this.#handleExit.bind(this))
    })
  }

  async #handleExit(code?: number): Promise<void> {
    this.#cleanupListeners()
    if (this.#status === 'running' || this.#status === 'backgrounded') {
      this.#status = 'completed'
    }

    const stdout = await this.taskOutput.getStdout()
    const result: ExecResult = {
      code,
      terminationFailure: this.#terminationFailure,
      stdout,
      outcomeKnown: code !== undefined,
      processObservation: code === undefined ? 'dead' : undefined,
      stderr: this.taskOutput.getStderr(),
      interrupted: code === SIGKILL,
      backgroundTaskId: this.#backgroundTaskId,
      terminationReason: this.#terminationAttempt?.reason,
    }

    if (this.taskOutput.stdoutToFile && !this.#backgroundTaskId) {
      if (this.taskOutput.outputFileRedundant) {
        // Small file — full content is in result.stdout, delete the file
        void this.taskOutput.deleteOutputFile()
      } else {
        // Large file — tell the caller where the full output lives
        result.outputFilePath = this.taskOutput.path
        result.outputFileSize = this.taskOutput.outputFileSize
        result.outputTaskId = this.taskOutput.taskId
      }
    }

    if (this.#killedForSize) {
      result.stderr = prependStderr(
        `Background command killed: output file exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY}`,
        result.stderr,
      )
    } else if (this.#terminationAttempt?.reason === 'timeout' && !this.#hadErrorAfterSpawn) {
      result.stderr = prependStderr(
        `Command timed out after ${formatDuration(this.#timeout)}`,
        result.stderr,
      )
    }

    this.#completionResolver(result)
    const resultResolver = this.#resultResolver
    if (resultResolver) {
      this.#resultResolver = null
      resultResolver(result)
    }
  }

  #markDispatchSucceeded(attempt: TerminationAttempt): void {
    if (attempt.dispatch !== 'pending') return
    attempt.dispatched = true
    attempt.dispatch = 'succeeded'
    if (attempt.dispatchTimer) {
      clearTimeout(attempt.dispatchTimer)
      attempt.dispatchTimer = undefined
    }
    attempt.settleDispatch()
  }

  #markDispatchFailed(attempt: TerminationAttempt): void {
    if (attempt.dispatch === 'succeeded') return
    if (attempt.dispatchTimer) {
      clearTimeout(attempt.dispatchTimer)
      attempt.dispatchTimer = undefined
    }
    attempt.dispatch = 'failed'
    attempt.settleDispatch()
  }

  #handleDispatchFailure(attempt: TerminationAttempt): void {
    if (
      this.#terminationAttempt?.generation !== attempt.generation ||
      !attempt.active ||
      attempt.dispatch === 'succeeded'
    ) return
    this.#markDispatchFailed(attempt)
    if (attempt.exit) {
      this.#settleAttemptExit(attempt)
    } else {
      this.#terminationFailure = true
      this.#startErrorProbe()
    }
  }

  #settleAttemptExit(attempt: TerminationAttempt): void {
    if (!attempt.active || this.#terminationAttempt?.generation !== attempt.generation || !attempt.exit) return
    const { code, signal } = attempt.exit
    const killed = attempt.dispatch === 'succeeded' && (signal !== null || attempt.exit.disappeared === true || this.#processControl.platform === 'win32')
    if (attempt.exit.disappeared === true) {
      this.#terminationConfirmed = killed
      this.#status = killed ? 'killed' : 'completed'
      if (killed && attempt.reason === 'output_limit') this.#killedForSize = true
      attempt.active = false
      attempt.settleDispatch()
      this.#resolveExitCode(undefined)
      return
    }
    this.#terminationConfirmed = killed
    this.#status = killed ? 'killed' : 'completed'
    if (killed && attempt.reason === 'output_limit') this.#killedForSize = true
    attempt.active = false
    attempt.settleDispatch()
    this.#resolveExitCode(
      code !== null && code !== undefined
        ? code
        : signal === 'SIGTERM'
          ? SIGTERM
          : signal === 'SIGKILL'
            ? SIGKILL
            : this.#terminationCode ?? 1,
    )
  }

  #doKill(code?: number, reason: ShellCommand['terminationReason'] = 'user'): TerminationAttempt | null {
    if (this.#processExited || this.#status === 'completed' || this.#status === 'killed') {
      return null
    }
    this.#terminationRequested = true
    let settleDispatch!: () => void
    const dispatchSettled = new Promise<void>(resolve => { settleDispatch = resolve })
    const attempt: TerminationAttempt = {
      generation: ++this.#terminationGeneration,
      reason,
      dispatched: false,
      active: true,
      dispatch: 'pending',
      dispatchSettled,
      settleDispatch,
    }
    this.#terminationAttempt = attempt
    this.#terminationFailure = false
    this.#terminationCode ??= code ?? DEFAULT_KILL_CODE
    const pid = this.#pid
    if (!pid) {
      attempt.dispatch = 'failed'
      attempt.settleDispatch()
      return attempt
    }
    // Bash commands are spawned detached on POSIX, so npm/vite descendants
    // share the shell's process group even if the CLI is exiting.
    if (this.#processControl.killGroup(pid)) {
      this.#markDispatchSucceeded(attempt)
    }
    attempt.dispatchTimer = setTimeout(() => {
      if (attempt.dispatch === 'pending') {
        this.#handleDispatchFailure(attempt)
      }
    }, TERMINATION_WAIT_MS)
    attempt.dispatchTimer.unref()
    this.#processControl.killTree(pid, error => {
      if (this.#terminationAttempt?.generation !== attempt.generation || !attempt.active) return
      if (!error) {
        this.#markDispatchSucceeded(attempt)
        if (attempt.exit) this.#settleAttemptExit(attempt)
        return
      }
      const childProcess = this.#childProcess
      if (!childProcess) {
        this.#handleDispatchFailure(attempt)
        return
      }
      try {
        const signal = this.#processControl.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'
        if (childProcess.kill(signal)) {
          this.#markDispatchSucceeded(attempt)
        } else {
          this.#handleDispatchFailure(attempt)
        }
      } catch {
        this.#handleDispatchFailure(attempt)
      }
      if (attempt.dispatch === 'succeeded' && attempt.exit) {
        this.#settleAttemptExit(attempt)
      }
    })
    return attempt
  }

  kill(): void {
    this.#doKill()
  }

  terminateAndWait(timeoutMs: number, reason: 'timeout' | 'user' | 'abort' | 'output_limit' = 'user'): Promise<boolean> {
    const attempt = this.#doKill(reason === 'timeout' ? SIGTERM : undefined, reason)
    if (!attempt) return Promise.resolve(this.#status === 'killed')
    const startedAt = Date.now()
    return this.waitForExit(timeoutMs).then(async exited => {
      if (
        exited &&
        attempt.exit &&
        attempt.dispatch === 'pending'
      ) {
        const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
        await Promise.race([
          attempt.dispatchSettled,
          new Promise<void>(resolve => setTimeout(resolve, remainingMs)),
        ])
        if (attempt.dispatch === 'pending') {
          this.#markDispatchFailed(attempt)
        }
        if (attempt.active) this.#settleAttemptExit(attempt)
      }
      const isCurrentAttempt = this.#terminationAttempt?.generation === attempt.generation
      const killed = exited && isCurrentAttempt && this.#status === 'killed'
      if (isCurrentAttempt) {
        this.#terminationFailure = !this.#processExited
        if (!killed) {
          attempt.active = false
          attempt.dispatched = false
          if (attempt.dispatch === 'pending') this.#markDispatchFailed(attempt)
        }
      }
      if (!killed && !this.#processExited) {
        this.#startErrorProbe()
      }
      if (isCurrentAttempt && !this.#processExited && reason === 'timeout') {
        this.#terminationFailureResolver?.({
          stdout: '',
          stderr: 'Command timed out; termination failed. Process exit is not confirmed.',
          interrupted: false,
          outcomeKnown: false,
          terminationFailure: true,
          terminationReason: reason,
        })
        this.#terminationFailureResolver = null
      }
      return killed
    })
  }

  confirmProcessDisappeared(): boolean {
    if (this.#processExited) return true
    const pid = this.#pid
    if (pid === undefined || pid === null || this.#processControl.probe(pid) !== 'dead') {
      return false
    }
    this.#stopErrorProbe()
    const attempt = this.#terminationAttempt
    if (attempt?.active) {
      attempt.exit = { code: null, signal: null, disappeared: true }
      this.#markProcessExited()
      if (attempt.dispatch !== 'pending') {
        this.#settleAttemptExit(attempt)
      }
    } else {
      this.#status = 'completed'
      this.#markProcessExited()
      this.#resolveExitCode(undefined)
    }
    return true
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#processExited) {
      return Promise.resolve(true)
    }
    return new Promise(resolve => {
      let settled = false
      const onExit = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        this.#exitWaiters.delete(onExit)
        resolve(true)
      }
      const timeoutId = setTimeout(() => {
        if (settled) return
        if (this.confirmProcessDisappeared()) {
          onExit()
          return
        }
        settled = true
        this.#exitWaiters.delete(onExit)
        resolve(false)
      }, timeoutMs)
      this.#exitWaiters.add(onExit)
      if (this.#processExited) onExit()
    })
  }

  background(taskId: string): boolean {
    if (!this.#processExited && (!this.#terminationRequested || this.#terminationFailure) && this.#status === 'running') {
      this.#backgroundTaskId = taskId
      this.#status = 'backgrounded'
      this.#cleanupListeners()
      if (this.taskOutput.stdoutToFile) {
        // File mode: child writes directly to the fd with no JS involvement.
        // The foreground timeout is gone, so watch file size to prevent
        // a stuck append loop from filling the disk (768GB incident).
        this.#startSizeWatchdog()
      } else {
        // Pipe mode: spill the in-memory buffer so readers can find it on disk.
        this.taskOutput.spillToDisk()
      }
      return true
    }
    return false
  }

  cleanup(): void {
    if (!this.#processExited) return
    this.#stdoutWrapper?.cleanup()
    this.#stderrWrapper?.cleanup()
    this.taskOutput.clear()
    this.#stopErrorProbe()
    // Must run before nulling #abortSignal — #cleanupListeners() calls
    // removeEventListener on it. Without this, a kill()+cleanup() sequence
    // crashes: kill() queues #handleExit as a microtask, cleanup() nulls
    // #abortSignal, then #handleExit runs #cleanupListeners() on the null ref.
    this.#cleanupListeners()
    // Release references to allow GC of ChildProcess internals and AbortController chain
    this.#childProcess = null
    this.#abortSignal = null!
    this.#onTimeoutCallback = undefined
  }
}

/**
 * Wraps a child process to enable flexible handling of shell command execution.
 */
export function wrapSpawn(
  childProcess: ChildProcess,
  abortSignal: AbortSignal,
  timeout: number,
  taskOutput: TaskOutput,
  shouldAutoBackground = false,
  maxOutputBytes = MAX_TASK_OUTPUT_BYTES,
  processControl?: ShellProcessControl,
): ShellCommand {
  return new ShellCommandImpl(
    childProcess,
    abortSignal,
    timeout,
    taskOutput,
    shouldAutoBackground,
    maxOutputBytes,
    processControl,
  )
}

/**
 * Static ShellCommand implementation for commands that were aborted before execution.
 */
class AbortedShellCommand implements ShellCommand {
  readonly status = 'killed' as const
  readonly pid = undefined
  readonly result: Promise<ExecResult>
  readonly taskOutput: TaskOutput

  constructor(opts?: {
    backgroundTaskId?: string
    stderr?: string
    code?: number
  }) {
    this.taskOutput = new TaskOutput(generateTaskId('local_bash'), null)
    this.result = Promise.resolve({
      code: opts?.code ?? 145,
      stdout: '',
      stderr: opts?.stderr ?? 'Command aborted before execution',
      interrupted: true,
      backgroundTaskId: opts?.backgroundTaskId,
    })
  }

  background(): boolean {
    return false
  }

  kill(): void {}

  terminateAndWait(): Promise<boolean> {
    return Promise.resolve(false)
  }

  get completion(): Promise<ExecResult> {
    return this.result
  }

  get terminationFailureResult(): Promise<ExecResult> {
    return this.result
  }

  cleanup(): void {}

  confirmProcessDisappeared(): boolean {
    return true
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true)
  }

  get terminationRequested(): boolean {
    return false
  }

  get terminationConfirmed(): boolean {
    return true
  }

  get terminationFailure(): boolean {
    return false
  }

  get terminationReason(): undefined {
    return undefined
  }

  get processExited(): boolean {
    return true
  }
}

export function createAbortedCommand(
  backgroundTaskId?: string,
  opts?: { stderr?: string; code?: number },
): ShellCommand {
  return new AbortedShellCommand({
    backgroundTaskId,
    ...opts,
  })
}

export function createFailedCommand(preSpawnError: string): ShellCommand {
  const taskOutput = new TaskOutput(generateTaskId('local_bash'), null)
  return {
    status: 'completed' as const,
    pid: undefined,
    result: Promise.resolve({
      code: 1,
      stdout: '',
      stderr: preSpawnError,
      interrupted: false,
      preSpawnError,
    }),
    taskOutput,
    background(): boolean {
      return false
    },
    kill(): void {},
    terminateAndWait(): Promise<boolean> {
      return Promise.resolve(false)
    },
    confirmProcessDisappeared(): boolean {
      return true
    },
    waitForExit(): Promise<boolean> {
      return Promise.resolve(true)
    },
    terminationRequested: false,
    terminationConfirmed: false,
    processExited: true,
    cleanup(): void {},
  }
}
