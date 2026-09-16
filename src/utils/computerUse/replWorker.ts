import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { createContext, Script } from 'node:vm'
import { compileReplCell, type ReplBinding } from './replCompiler'
import type { ReplInput, ReplOutput } from '../../vendor/computer-use-mcp/replProtocol'

interface CellState {
  cellId: number
  accepting: boolean
  finished: boolean
  pending: Map<number, { settled: Promise<void>; settle: () => void }>
  timers: Map<number, ReturnType<typeof setTimeout>>
  timerError?: string
  failTimer(message: string): void
}

interface RealmRuntime {
  begin(): void
  scope(writableConstants: string[]): unknown
  register(entries: unknown): void
  mark(...names: string[]): void
  commit(succeeded: boolean): string
  response(message: string): void
  unobservedError(): string | undefined
  fireTimer(id: number): void
  clearTimers(): void
  execute(fn: unknown): Promise<unknown>
}

const MAX_ACTIVE_TIMERS = 1024

function errorMessage(error: unknown): string {
  try {
    return String((error as { message?: unknown })?.message ?? error).slice(0, 8_000)
  } catch {
    return 'JavaScript execution failed'
  }
}

/**
 * Persistent JavaScript kernel. Production runs this in a disposable process;
 * vm is a language boundary, not the OS sandbox or hard time/memory limit.
 * Only JSON strings cross its host bridge. In particular no host Promise,
 * Error, timer handle/function, module loader, or Node object is passed into the realm.
 */
export function createComputerUseReplWorker(send: (message: ReplOutput) => void) {
  const context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  })
  const execution = new AsyncLocalStorage<CellState>()
  let active: CellState | undefined
  let initialized = false
  let initializing = false
  let bindings: ReplBinding[] = []
  const bridgeName = `__cu_host_${randomUUID().replaceAll('-', '_')}`

  context[bridgeName] = (serialized: string): string | undefined => {
    try {
      const message = JSON.parse(serialized)
      const cell = execution.getStore()
      if (!cell || cell.finished || cell !== active) {
        // Late output is discarded. Throwing here would turn an otherwise
        // handled rejection in detached user code into an unhandled rejection.
        if (message.type === 'emit') {
          return
        }
        return 'This JavaScript cell has ended; await every Computer Use operation'
      }
      if (message.type === 'emit') {
        send({ type: 'emit', cellId: cell.cellId, content: message.content })
        return
      }
      if (message.type === 'submitted_done') {
        cell.accepting = false
        return
      }
      if (message.type === 'timer_error' && typeof message.message === 'string') {
        cell.failTimer(message.message.slice(0, 8_000))
        return
      }
      if (message.type === 'timer' && cell.accepting) {
        const { id } = message
        if (!Number.isSafeInteger(id) || id < 1) return 'Invalid JavaScript timer ID'
        if (message.action === 'clear') {
          const handle = cell.timers.get(id)
          if (handle !== undefined) clearTimeout(handle)
          cell.timers.delete(id)
          return
        }
        if (message.action !== 'schedule' || typeof message.interval !== 'boolean'
          || !Number.isInteger(message.delay) || message.delay < 0 || message.delay > 2_147_483_647) {
          return 'Invalid JavaScript timer request'
        }
        if (cell.timers.has(id)) return 'Duplicate JavaScript timer ID'
        if (cell.timers.size >= MAX_ACTIVE_TIMERS) return 'Too many active JavaScript timers (maximum 1024)'
        const fire = () => {
          if (cell !== active || cell.finished || !cell.accepting) return
          if (!message.interval) cell.timers.delete(id)
          try {
            realm.fireTimer(id)
          } catch (error) {
            cell.failTimer(errorMessage(error))
          }
        }
        const handle = message.interval ? setInterval(fire, message.delay) : setTimeout(fire, message.delay)
        cell.timers.set(id, handle)
        return
      }
      if (message.type !== 'invoke' || !cell.accepting) {
        return 'Submitted JavaScript has completed; await every Computer Use operation'
      }
      if (
        !Number.isSafeInteger(message.requestId)
        || typeof message.name !== 'string'
        || !message.args
        || typeof message.args !== 'object'
        || Array.isArray(message.args)
      ) {
        return 'Invalid Computer Use bridge request'
      }
      if (cell.pending.has(message.requestId)) {
        return 'Duplicate Computer Use bridge request'
      }
      let settle!: () => void
      const settled = new Promise<void>(resolve => {
        settle = resolve
      })
      cell.pending.set(message.requestId, { settled, settle })
      // The drain waits for requests that were sent before the submitted cell
      // completed. New requests from detached continuations are rejected.
      try {
        send({
          type: 'invoke',
          cellId: cell.cellId,
          requestId: message.requestId,
          name: message.name,
          args: message.args,
        })
      } catch (error) {
        cell.pending.delete(message.requestId)
        settle()
        return errorMessage(error)
      }
      return
    } catch (error) {
      return errorMessage(error)
    }
  }

  const realm = new Script(`(() => {
    const hostSend = globalThis[${JSON.stringify(bridgeName)}]
    delete globalThis[${JSON.stringify(bridgeName)}]
    const pending = new Map()
    let operations = []
    let requestCounter = 0
    const saved = new Map()
    const previous = new Map()
    const reached = new Set()
    let candidate = []
    const timers = new Map()
    let timerCounter = 0
    const scheduleTimer = (callback, delay, args, interval) => {
      if (typeof callback !== 'function') throw new TypeError('Timer callback must be a function')
      delay = Number(delay)
      // Match Node's asynchronous minimum and integer delay normalization,
      // without exposing Node functions or its Timeout objects to the guest.
      delay = !Number.isFinite(delay) || delay < 1 || delay > 2147483647 ? 1 : Math.trunc(delay)
      const id = ++timerCounter
      timers.set(id, {callback, args, interval})
      const failure = hostSend(JSON.stringify({type: 'timer', action: 'schedule', id, delay, interval}))
      if (failure) {
        timers.delete(id)
        throw new Error(failure)
      }
      return id
    }
    const clearTimer = value => {
      const id = typeof value === 'string' ? Number(value) : value
      if (!timers.has(id)) return
      const failure = hostSend(JSON.stringify({type: 'timer', action: 'clear', id}))
      if (failure) throw new Error(failure)
      timers.delete(id)
    }
    const invoke = (name, args) => {
      const requestId = ++requestCounter
      const operation = {observed: false, error: undefined}
      const promise = new Promise((resolve, reject) => {
        pending.set(requestId, {resolve, reject, operation})
        let failure
        try {
          failure = hostSend(JSON.stringify({type: 'invoke', requestId, name, args}))
        } catch {
          failure = 'Could not serialize Computer Use arguments'
        }
        if (failure) {
          pending.delete(requestId)
          reject(new Error(failure))
        } else {
          operations.push(operation)
        }
      })
      promise.catch(() => {})
      // Track whether submitted code consumes this operation. A separate
      // successful await must not hide an earlier ignored native failure.
      return {
        then(onFulfilled, onRejected) {
          operation.observed = true
          return promise.then(onFulfilled, onRejected)
        },
        catch(onRejected) {
          operation.observed = true
          return promise.catch(onRejected)
        },
        finally(onFinally) {
          operation.observed = true
          return promise.finally(onFinally)
        },
      }
    }
    const emit = content => {
      const failure = hostSend(JSON.stringify({type: 'emit', content}))
      if (failure) {
        throw new Error(failure)
      }
    }
    Object.defineProperties(globalThis, {
      __cuInvoke: {value: invoke},
      __cuEmit: {value: emit},
      setTimeout: {value: (callback, delay = 0, ...args) => scheduleTimer(callback, delay, args, false)},
      clearTimeout: {value: clearTimer},
      setInterval: {value: (callback, delay = 0, ...args) => scheduleTimer(callback, delay, args, true)},
      clearInterval: {value: clearTimer},
    })
    return {
      execute(fn) {
        // Close dispatch at the submitted promise's first settlement, before
        // the host's timer-error race adds another promise checkpoint. Keep
        // these handlers guest-created; no host callbacks enter the realm.
        return fn(this.scope, this.register, this.mark).then(value => {
          hostSend(JSON.stringify({type: 'submitted_done'}))
          return value
        }, error => {
          hostSend(JSON.stringify({type: 'submitted_done'}))
          throw error
        })
      },
      fireTimer(id) {
        const entry = timers.get(id)
        if (!entry) return
        if (!entry.interval) timers.delete(id)
        const result = Reflect.apply(entry.callback, undefined, entry.args)
        // Async callbacks can reject while the submitted code awaits another
        // event. Attribute that error to this cell instead of crashing the host.
        Promise.resolve(result).catch(error => {
          let message
          try { message = String(error?.message ?? error).slice(0, 8000) }
          catch { message = 'JavaScript timer callback failed' }
          hostSend(JSON.stringify({type: 'timer_error', message}))
        })
      },
      clearTimers() {
        timers.clear()
      },
      begin() {
        operations = []
        reached.clear()
        previous.clear()
        candidate = []
      },
      scope(writableConstants) {
        const writable = new Set(writableConstants)
        const values = new Proxy(Object.create(null), {
          get(_target, name) {
            const entry = saved.get(name)
            if (!entry && Reflect.has(globalThis, name)) return Reflect.get(globalThis, name)
            if (!entry) throw new ReferenceError(String(name) + ' is not defined')
            return entry.get()
          },
          set(_target, name, value) {
            const entry = saved.get(name)
            if (!entry) {
              if (!Reflect.has(globalThis, name)) throw new ReferenceError(String(name) + ' is not defined')
              if (!Reflect.set(globalThis, name, value)) throw new TypeError('Assignment to readonly global.')
              return true
            }
            if (entry.kind === 'const' && writable.has(name)) {
              // A prior cell's const may be reassigned with the compiler's
              // warning. Keep the shared slot, including readers in closures.
              entry.get()
              entry.get = () => value
              entry.set = next => { value = next }
            } else {
              if (entry.kind === 'const') {
                entry.get() // Preserve TDZ before the immutable-binding error.
                throw new TypeError('Assignment to constant variable.')
              }
              entry.set(value)
            }
            return true
          },
        })
        return {
          values,
          typeOf(name) {
            if (!saved.has(name) && !Reflect.has(globalThis, name)) return 'undefined'
            return typeof values[name]
          },
        }
      },
      register(entries) {
        candidate = entries
        for (const [name, kind, get, set] of entries) {
          previous.set(name, saved.get(name))
          saved.set(name, {kind, get, set})
        }
      },
      mark(...names) {
        for (const name of names) {
          reached.add(name)
        }
      },
      commit(succeeded) {
        for (const [name, _kind, getter, _setter, newlyHoisted] of candidate) {
          let retain = succeeded || !newlyHoisted || reached.has(name)
          try {
            getter()
          } catch {
            retain = false // The declaration was not initialized before failure.
          }
          if (!retain) {
            const old = previous.get(name)
            if (old) saved.set(name, old)
            else saved.delete(name)
          }
        }
        candidate = []
        previous.clear()
        return JSON.stringify([...saved].map(([name, entry]) => ({name, kind: entry.kind})))
      },
      response(serialized) {
        const message = JSON.parse(serialized)
        const entry = pending.get(message.requestId)
        if (!entry) {
          return
        }
        pending.delete(message.requestId)
        if (typeof message.error === 'string') {
          entry.operation.error = message.error
          entry.reject(new Error(message.error))
        } else {
          if (message.result?.isError === true) {
            const text = Array.isArray(message.result.content)
              ? message.result.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\\n')
              : ''
            entry.operation.error = text || 'Computer Use action failed.'
          }
          entry.resolve(message.result)
        }
      },
      unobservedError() {
        const failed = operations.find(operation => !operation.observed && typeof operation.error === 'string')
        return failed?.error
      },
    }
  })()`).runInContext(context) as RealmRuntime

  async function run(cellId: number, code: string, bootstrap = false) {
    if (active) {
      send({ type: 'done', cellId, error: 'A JavaScript cell is already running' })
      return
    }
    let rejectTimer!: (error: Error) => void
    const timerFailure = new Promise<never>((_resolve, reject) => { rejectTimer = reject })
    const cell: CellState = {
      cellId, accepting: true, finished: false, pending: new Map(), timers: new Map(),
      failTimer(message) {
        if (cell.timerError !== undefined) return
        cell.timerError = message || 'JavaScript timer callback failed'
        cell.accepting = false
        rejectTimer(new Error(cell.timerError))
      },
    }
    active = cell
    realm.begin()
    let error: string | undefined
    let submittedSucceeded = false
    await execution.run(cell, async () => {
      try {
        const compiled = compileReplCell(code, bindings)
        const execute = new Script(compiled.source, { filename: 'computer-use-cell.js' }).runInContext(context)
        for (const warning of compiled.warnings) {
          send({ type: 'emit', cellId, content: { type: 'text', text: `Warning: ${warning}` } })
        }
        await Promise.race([realm.execute(execute), timerFailure])
        submittedSucceeded = true
      } catch (failure) {
        error = errorMessage(failure)
      } finally {
        cell.accepting = false
        for (const handle of cell.timers.values()) clearTimeout(handle)
        cell.timers.clear()
        realm.clearTimers()
        // A response can settle a pending call on another stdin callback. Keep
        // this cell alive until those calls finish, without reopening dispatch.
        while (cell.pending.size > 0) {
          await Promise.all([...cell.pending.values()].map(request => request.settled))
        }
        // The facade awaits its bridge internally, but a caller can still
        // ignore the outer async App-method promise. Its rejection is reported
        // by the host only after microtasks finish. Do not publish success
        // before that checkpoint; the process-level rejection handler resets
        // the kernel while the parent still considers this cell active.
        // A detached infinite microtask chain also remains under its deadline.
        await new Promise<void>(resolve => setImmediate(resolve))
        const backgroundError = realm.unobservedError()
        if (!error && cell.timerError !== undefined) error = cell.timerError
        if (!error && backgroundError) {
          error = `An unawaited Computer Use operation failed: ${backgroundError}. Observe the current state before continuing; do not replay prior actions.`
        }
        bindings = JSON.parse(realm.commit(submittedSucceeded)) as ReplBinding[]
        cell.finished = true
        active = undefined
      }
    })
    if (bootstrap) {
      if (error) {
        throw new Error(error)
      }
    } else {
      send({ type: 'done', cellId, ...(error ? { error } : {}) })
    }
  }

  return {
    async receive(message: ReplInput): Promise<void> {
      if (message.type === 'ping') {
        send({ type: 'pong', nonce: message.nonce })
        return
      }
      if (message.type === 'init') {
        if (initialized || initializing) {
          throw new Error('Computer Use JavaScript worker is already initialized')
        }
        initializing = true
        try {
          await run(0, message.bootstrap, true)
          initialized = true
          send({ type: 'ready' })
        } finally {
          initializing = false
        }
        return
      }
      if (message.type === 'response') {
        const cell = active
        if (!cell || cell.cellId !== message.cellId) {
          return
        }
        const pending = cell.pending.get(message.requestId)
        if (!pending) {
          return
        }
        cell.pending.delete(message.requestId)
        realm.response(JSON.stringify(message))
        pending.settle()
        return
      }
      if (!initialized) {
        send({ type: 'done', cellId: message.cellId, error: 'Computer Use JavaScript worker is not initialized' })
        return
      }
      await run(message.cellId, message.code)
    },
  }
}

export async function runComputerUseReplWorker(): Promise<void> {
  const stopAfterAsyncFailure = () => {
    process.stderr.write('Computer Use JavaScript worker stopped after an unhandled asynchronous error.\n')
    process.exit(1)
  }
  process.on('unhandledRejection', stopAfterAsyncFailure)
  process.on('uncaughtException', stopAfterAsyncFailure)
  process.stdout.on('error', error => {
    process.exit((error as NodeJS.ErrnoException).code === 'EPIPE' ? 0 : 1)
  })
  const worker = createComputerUseReplWorker(message => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  })
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of input) {
    try {
      const message = JSON.parse(line) as ReplInput
      // Do not block stdin: responses resolve the currently running cell.
      void worker.receive(message).catch(() => process.exit(1))
    } catch {
      process.exitCode = 1
      input.close()
      break
    }
  }
  // The parent owns the kernel. A closed input pipe cannot service new calls.
  process.exit(process.exitCode || 0)
}

if (import.meta.main) {
  await runComputerUseReplWorker()
}
