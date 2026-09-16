import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { AsyncResource } from 'node:async_hooks'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js'
import { isInBundledMode } from '../bundledMode.js'
import { REPL_BOOTSTRAP_SOURCE } from '../../vendor/computer-use-mcp/replApi.js'
import {
  REPL_MAX_ACTIONS,
  REPL_MAX_CODE_BYTES,
  REPL_MAX_OUTPUT_BYTES,
  type ComputerUseReplRuntime,
  type ReplContent,
  type ReplInput,
  type ReplInvoke,
  type ReplOutput,
} from '../../vendor/computer-use-mcp/replProtocol.js'
import type { CuCallToolResult } from '../../vendor/computer-use-mcp/toolCalls.js'

const INVOCABLE_TOOLS = new Set([
  'list_apps', 'get_app_state', 'click', 'drag', 'scroll', 'press_key',
  'type_text', 'paste', 'set_value', 'select_text', 'perform_secondary_action',
])
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function createComputerUseReplSandboxCommand(options: { args: string[], readable: string[], directory: string }): string {
  // sandbox-runtime adds its own TMPDIR outside this command. Override it
  // inside the sandbox without changing the parent process's environment.
  const args = ['/usr/bin/env', ...['TMPDIR', 'TMP', 'TEMP'].map(name => `${name}=${options.directory}`), ...options.args]
  return wrapCommandWithSandboxMacOS({
    command: `exec ${args.map(quote).join(' ')}`,
    // /bin/sh is a selector stub on recent macOS and may open
    // /private/var/select/sh. Execute the concrete system shell directly.
    binShell: '/bin/bash',
    needsNetworkRestriction: true,
    readConfig: {
      denyOnly: ['/'],
      allowWithinDeny: [...options.readable, '/System', '/usr/lib', '/usr/share', '/bin/bash', '/usr/bin/env', '/dev', '/private/etc/localtime'],
    },
    writeConfig: { allowOnly: [options.directory, '/dev/null'], denyWithinAllow: [] },
  })
}

interface Kernel {
  process: ChildProcessWithoutNullStreams
  directory: string
  ready: Promise<void>
  rejectReady: (error: Error) => void
  buffer: string
  stderr: string
  health?: ReturnType<typeof setInterval>
  heartbeat?: { nonce: number, sentAt: number }
}

interface Cell {
  id: number
  accepting: boolean
  controller: AbortController
  content: ReplContent[]
  bytes: number
  actions: number
  started: number
  completed: number
  rejectedBeforeDispatch: number
  actionFailed: boolean
  requests: Set<number>
  tail: Promise<void>
  finish: (error?: string, invalidate?: boolean) => void
  result: Promise<CuCallToolResult>
  invoke: ReplInvoke
}

// Idle kernels must not keep the CLI alive. Exit also removes their disposable
// files; neither compilation nor execution uses the user's home or config.
const liveKernels = new Set<Kernel>()
let exitHookInstalled = false
function killKernel(kernel: Kernel) {
  liveKernels.delete(kernel)
  clearInterval(kernel.health)
  try { if (kernel.process.pid) process.kill(-kernel.process.pid, 'SIGKILL') } catch {}
  kernel.process.kill('SIGKILL')
  kernel.process.stdin.destroy()
  kernel.process.stdout.destroy()
  kernel.process.stderr.destroy()
  kernel.rejectReady(new Error('Computer Use JavaScript kernel stopped.'))
}

/** Persistent JS lives in a disposable sandboxed child, never in the CLI VM. */
export class ComputerUseRepl implements ComputerUseReplRuntime {
  private kernel?: Kernel
  private cell?: Cell
  private nextCellId = 0
  private idleFailure?: string

  constructor(private readonly limits = { maxRssBytes: 768 * 1024 * 1024, healthCheckMs: 1000 }) {}

  private async start(signal: AbortSignal): Promise<Kernel> {
    if (this.kernel) return this.kernel
    if (process.platform !== 'darwin') throw new Error('Computer Use JavaScript is currently available on macOS only.')
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'cc-haha-cu-repl-')))
    try {
      const executable = await realpath(process.execPath)
      let args: string[]
      let readable: string[]
      // A compiled Bun program with no embedded asset imports reports an
      // empty embeddedFiles array. Its modules still live in Bun's virtual FS.
      if (isInBundledMode() || import.meta.url.startsWith('file:///$bunfs/')) {
        args = [executable, '--computer-use-repl-worker']
        readable = [executable, directory]
      } else {
        // One self-contained script keeps the sandbox from reading the source
        // checkout, node_modules, .env files or provider configuration.
        const build = await Bun.build({
          entrypoints: [fileURLToPath(new URL('./replWorker.ts', import.meta.url))],
          outdir: directory,
          target: 'bun',
          format: 'esm',
          packages: 'bundle',
        })
        if (!build.success) throw new Error(`Could not build Computer Use kernel: ${build.logs.join('\n')}`)
        args = [executable, '--no-env-file', join(directory, 'replWorker.js')]
        readable = [executable, directory]
      }
      if (signal.aborted) throw new Error('Computer Use JavaScript cancelled before startup.')
      // Use the existing pure macOS wrapper, not SandboxManager's shared Bash
      // configuration/proxies. No network, Unix sockets, PTY or user files.
      const command = createComputerUseReplSandboxCommand({ args, readable, directory })
      const child = spawn('/bin/sh', ['-c', `exec ${command}`], {
        cwd: directory,
        detached: true,
        stdio: 'pipe',
        env: {
          HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
          PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', BUN_OPTIONS: '--no-env-file',
          CLAUDE_CONFIG_DIR: join(directory, '.claude'),
        },
      })
      let ready!: () => void
      let rejectReady!: (error: Error) => void
      const readyPromise = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject })
      // An exit before run() starts awaiting readiness must not be unhandled.
      void readyPromise.catch(() => {})
      const kernel: Kernel = { process: child, directory, ready: readyPromise, rejectReady, buffer: '', stderr: '' }
      this.kernel = kernel
      liveKernels.add(kernel)
      if (!exitHookInstalled) {
        exitHookInstalled = true
        process.once('exit', () => {
          for (const item of liveKernels) {
            killKernel(item)
            rmSync(item.directory, { recursive: true, force: true })
          }
        })
      }
      const failed = (message: string) => {
        rejectReady(new Error(message))
        if (this.kernel !== kernel) return
        if (this.cell) this.cell.finish(message, true)
        else {
          this.idleFailure = `${message} Bindings were reset. Select the app again.`
          this.kernel = undefined
          killKernel(kernel)
          void rm(kernel.directory, { recursive: true, force: true }).catch(() => {})
        }
      }
      child.on('error', error => failed(errorText(error)))
      child.on('exit', (code, sig) => failed(`Computer Use JavaScript kernel exited (${sig ?? code}). ${kernel.stderr}`))
      child.stdin.on('error', error => failed(errorText(error)))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        kernel.stderr = (kernel.stderr + chunk).slice(-4096)
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (this.kernel !== kernel) return
        kernel.buffer += chunk
        if (Buffer.byteLength(kernel.buffer) > REPL_MAX_OUTPUT_BYTES) {
          failed('Computer Use JavaScript exceeded the output limit.')
          return
        }
        let newline: number
        while ((newline = kernel.buffer.indexOf('\n')) >= 0) {
          const line = kernel.buffer.slice(0, newline)
          kernel.buffer = kernel.buffer.slice(newline + 1)
          try {
            const message = JSON.parse(line) as ReplOutput
            if (message.type === 'ready') ready()
            else if (message.type === 'pong') {
              if (message.nonce === kernel.heartbeat?.nonce) kernel.heartbeat = undefined
            }
            else this.receive(kernel, message)
          } catch {
            failed('Computer Use JavaScript kernel sent invalid protocol data.')
          }
        }
      })
      let nonce = 0
      let checkingMemory = false
      kernel.health = setInterval(() => {
        if (this.kernel !== kernel) return
        // Bun has no supported hard heap cap. This independent RSS watchdog is
        // a soft resource limit; a runaway VM cannot prevent the parent check.
        if (!checkingMemory && child.pid) {
          checkingMemory = true
          execFile('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { timeout: 1000, maxBuffer: 1024 }, (error, stdout) => {
            checkingMemory = false
            if (error || this.kernel !== kernel) return
            const rssBytes = Number(stdout.trim()) * 1024
            if (Number.isFinite(rssBytes) && rssBytes > this.limits.maxRssBytes) failed('Computer Use JavaScript exceeded its memory budget.')
          })
        }
        if (this.cell) {
          kernel.heartbeat = undefined
          return
        }
        if (kernel.heartbeat) {
          if (Date.now() - kernel.heartbeat.sentAt > 2000) failed('Computer Use JavaScript left an unresponsive background task.')
        } else {
          kernel.heartbeat = { nonce: ++nonce, sentAt: Date.now() }
          this.send(kernel, { type: 'ping', nonce })
        }
      }, this.limits.healthCheckMs)
      kernel.health.unref()
      this.send(kernel, { type: 'init', bootstrap: REPL_BOOTSTRAP_SOURCE })
      return kernel
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  private send(kernel: Kernel, message: ReplInput) {
    if (this.kernel === kernel && !kernel.process.stdin.destroyed) {
      kernel.process.stdin.write(`${JSON.stringify(message)}\n`)
    }
  }

  private receive(kernel: Kernel, message: ReplOutput) {
    const cell = this.cell
    if (!cell || !cell.accepting || !('cellId' in message) || message.cellId !== cell.id) return
    if (message.type === 'done') {
      cell.finish(message.error)
    } else if (message.type === 'emit') {
      const content = message.content
      if (!content || (content.type !== 'text' && content.type !== 'image') ||
        (content.type === 'text' ? typeof content.text !== 'string' :
          typeof content.data !== 'string' || typeof content.mimeType !== 'string' || !/^image\/(png|jpeg|webp)$/.test(content.mimeType))) {
        cell.finish('Computer Use JavaScript emitted invalid content.', true)
        return
      }
      cell.bytes += Buffer.byteLength(JSON.stringify(content))
      if (cell.bytes > REPL_MAX_OUTPUT_BYTES || cell.content.length >= 128) {
        cell.finish('Computer Use JavaScript exceeded the output limit.', true)
      } else cell.content.push(content)
    } else if (message.type === 'invoke') {
      if (!Number.isSafeInteger(message.requestId) || cell.requests.has(message.requestId) ||
        !INVOCABLE_TOOLS.has(message.name) || ++cell.actions > REPL_MAX_ACTIONS) {
        cell.finish('Computer Use JavaScript exceeded its action limit or requested an invalid operation.', true)
        return
      }
      cell.requests.add(message.requestId)
      // Even Promise.all cannot interleave target acquisition, injection and
      // observation. A cell is one item in the outer semantic session queue.
      cell.tail = cell.tail.then(async () => {
        if (!cell.accepting || cell.controller.signal.aborted) return
        ++cell.started
        try {
          const result = await cell.invoke(message.name, message.args, cell.controller.signal)
          if (result.isError) {
            if (result.nativeCallNotDispatched === true) ++cell.rejectedBeforeDispatch
            else cell.actionFailed = true
          } else ++cell.completed
          if (!cell.accepting) return
          // A completed command rejection is structured API data. The facade
          // recreates its typed error in the guest; transport failures below
          // still reject the RPC itself.
          this.send(kernel, { type: 'response', cellId: cell.id, requestId: message.requestId, result })
        } catch (error) {
          cell.actionFailed = true
          if (cell.accepting) this.send(kernel, { type: 'response', cellId: cell.id, requestId: message.requestId, error: errorText(error) })
        }
      })
    }
  }

  async run(options: Parameters<ComputerUseReplRuntime['run']>[0], invoke: ReplInvoke): Promise<CuCallToolResult> {
    if (this.cell) return { isError: true, content: [{ type: 'text', text: 'A Computer Use JavaScript cell is already running.' }] }
    if (this.idleFailure) {
      const text = this.idleFailure
      this.idleFailure = undefined
      return { isError: true, content: [{ type: 'text', text }] }
    }
    if (typeof options.code !== 'string' || Buffer.byteLength(options.code) > REPL_MAX_CODE_BYTES ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000) {
      return { isError: true, content: [{ type: 'text', text: 'Invalid Computer Use JavaScript code or timeout (maximum 60 seconds).' }] }
    }
    const controller = new AbortController()
    let resolve!: (result: CuCallToolResult) => void
    const result = new Promise<CuCallToolResult>(done => { resolve = done })
    let deadline: ReturnType<typeof setTimeout>
    let poll: ReturnType<typeof setInterval>
    const cancelled = () => cell.finish('Computer Use JavaScript cancelled. Bindings were reset; observe the app before continuing.', true)
    const cell: Cell = {
      id: ++this.nextCellId, accepting: true, controller, content: [], bytes: 0,
      actions: 0, started: 0, completed: 0, rejectedBeforeDispatch: 0, actionFailed: false, requests: new Set(), tail: Promise.resolve(), result,
      // The warm worker's stdout listener retains its startup async context.
      // Native dispatch must instead read this cell caller's state and aborts.
      invoke: AsyncResource.bind(invoke),
      finish: (error, invalidate = false) => {
        if (!cell.accepting) return
        cell.accepting = false
        clearTimeout(deadline)
        clearInterval(poll)
        options.signal?.removeEventListener('abort', cancelled)
        if (invalidate) {
          controller.abort()
          const kernel = this.kernel
          this.kernel = undefined
          if (kernel) {
            killKernel(kernel)
            void rm(kernel.directory, { recursive: true, force: true }).catch(() => {})
          }
        }
        // A native event already being injected cannot be undone. Drain that
        // one operation before releasing the session queue; queued RPCs stop.
        void cell.tail.then(() => {
          if (this.cell === cell) this.cell = undefined
          const kernel = this.kernel
          if (kernel) {
            kernel.process.unref()
            for (const stream of [kernel.process.stdin, kernel.process.stdout, kernel.process.stderr]) {
              (stream as typeof stream & { unref?: () => void }).unref?.()
            }
          }
          resolve({
            content: [...cell.content, ...(error ? [{ type: 'text' as const, text: error }] : [])],
            ...(error ? {
              isError: true,
              structuredContent: {
                nativeCallsStarted: cell.started,
                nativeCallsCompleted: cell.completed,
                nativeCallsRejectedBeforeDispatch: cell.rejectedBeforeDispatch,
                nativeResultUnknown: cell.actionFailed || cell.started !== cell.completed + cell.rejectedBeforeDispatch,
                bindingsReset: invalidate,
                recovery: cell.started === cell.rejectedBeforeDispatch
                  ? 'No native actions were dispatched. Resolve the reported error before retrying.'
                  : 'Observe the app before retrying. Completed calls were dispatched, but their visual effect still needs verification.',
              },
            } : {}),
          })
        })
      },
    }
    this.cell = cell
    deadline = setTimeout(() => cell.finish('Computer Use JavaScript timed out. Bindings were reset; observe the app before continuing.', true), options.timeoutMs)
    poll = setInterval(() => { if (options.isAborted?.()) cancelled() }, 50)
    options.signal?.addEventListener('abort', cancelled, { once: true })
    if (options.signal?.aborted || options.isAborted?.()) cancelled()
    else {
      try {
        const kernel = await this.start(controller.signal)
        if (cell.accepting) {
          kernel.process.ref()
          for (const stream of [kernel.process.stdin, kernel.process.stdout, kernel.process.stderr]) {
            (stream as typeof stream & { ref?: () => void }).ref?.()
          }
          await kernel.ready
          if (cell.accepting) this.send(kernel, { type: 'run', cellId: cell.id, code: options.code })
        }
      } catch (error) {
        cell.finish(`Computer Use JavaScript startup failed: ${errorText(error)}`, true)
      }
    }
    return result
  }

  async reset() {
    this.idleFailure = undefined
    const cell = this.cell
    const kernel = this.kernel
    cell?.finish('Computer Use JavaScript reset. Bindings were discarded.', true)
    if (kernel && this.kernel === kernel) {
      this.kernel = undefined
      killKernel(kernel)
      await rm(kernel.directory, { recursive: true, force: true })
    }
    if (cell) await cell.result
  }
}
