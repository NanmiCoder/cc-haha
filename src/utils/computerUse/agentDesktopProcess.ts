import { spawn } from 'node:child_process'

// Linux X11 reserves two seconds to release held input after SIGTERM.
const TERMINATION_GRACE_MS = 2_250

export type AgentDesktopProcessRequest = {
  binaryPath: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs: number
  maxOutputBytes: number
}

export type AgentDesktopProcessResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

export type AgentDesktopRunner = (
  request: AgentDesktopProcessRequest,
) => Promise<AgentDesktopProcessResult>

export class AgentDesktopProcessError extends Error {
  constructor(
    message: string,
    public readonly reason: 'aborted' | 'timeout' | 'output_limit' | 'spawn_failed' | 'invalid_response' | 'disabled',
    public readonly dispatched: boolean,
  ) {
    super(message)
    this.name = 'AgentDesktopProcessError'
  }
}

export const runAgentDesktopProcess: AgentDesktopRunner = request => new Promise((resolve, reject) => {
  if (request.signal?.aborted) {
    reject(new AgentDesktopProcessError('Desktop command was cancelled before dispatch', 'aborted', false))
    return
  }

  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let started = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  let terminationError: AgentDesktopProcessError | undefined
  const child = spawn(request.binaryPath, request.args, {
    cwd: request.cwd,
    env: request.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const finish = (error?: AgentDesktopProcessError, exitCode: number | null = null) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(forceKillTimer)
    request.signal?.removeEventListener('abort', abort)
    if (error) reject(error)
    else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode })
  }
  const stop = (reason: 'aborted' | 'timeout' | 'output_limit') => {
    if (settled || terminationError) return
    clearTimeout(timer)
    terminationError = new AgentDesktopProcessError(
      `Desktop command ${reason === 'aborted' ? 'was cancelled' : reason === 'timeout' ? 'timed out' : 'exceeded the output limit'}; execution result is unknown. Inspect live state before another action.`,
      reason,
      started || child.pid !== undefined,
    )
    child.kill()
    forceKillTimer = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS)
    forceKillTimer.unref()
  }
  const abort = () => stop('aborted')
  child.once('spawn', () => { started = true })
  child.once('error', error => finish(terminationError ?? new AgentDesktopProcessError(
    `Could not run agent-desktop: ${error.message}`,
    'spawn_failed',
    started,
  )))
  child.stdout.on('data', (chunk: Buffer) => {
    if (settled || terminationError) return
    stdoutBytes += chunk.length
    if (stdoutBytes > request.maxOutputBytes) stop('output_limit')
    else stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (settled || terminationError) return
    stderrBytes += chunk.length
    if (stderrBytes > 64 * 1024) stop('output_limit')
    else stderr.push(chunk)
  })
  child.once('close', code => {
    finish(terminationError, code)
  })
  timer = setTimeout(() => stop('timeout'), request.timeoutMs)
  request.signal?.addEventListener('abort', abort, { once: true })
  if (request.signal?.aborted) abort()
})
