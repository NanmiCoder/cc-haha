import type { Terminal as XTermTerminal, IDisposable } from '@xterm/xterm'
import type { FitAddon as XTermFitAddon } from '@xterm/addon-fit'
import { terminalApi } from '../api/terminal'

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error' | 'unavailable'

export type TerminalShellInfo = {
  shell: string
  cwd: string
}

export type TerminalRuntime = {
  id: string
  terminal: XTermTerminal | null
  fit: XTermFitAddon | null
  nativeSessionId: number | null
  unlisteners: Array<() => void>
  dataDisposable: IDisposable | null
  startPromise: Promise<void> | null
  startToken: number
  status: TerminalStatus
  error: string | null
  title: string
  restart: (() => void) | null
  shellInfo: TerminalShellInfo | null
  listeners: Set<() => void>
}

const runtimes = new Map<string, TerminalRuntime>()
let localRuntimeCounter = 0

export function createLocalTerminalRuntimeId() {
  localRuntimeCounter += 1
  return `local-terminal-${localRuntimeCounter}`
}

export function getTerminalRuntime(id: string, initialStatus: TerminalStatus): TerminalRuntime {
  const existing = runtimes.get(id)
  if (existing) return existing

  const runtime: TerminalRuntime = {
    id,
    terminal: null,
    fit: null,
    nativeSessionId: null,
    unlisteners: [],
    dataDisposable: null,
    startPromise: null,
    startToken: 0,
    status: initialStatus,
    error: null,
    shellInfo: null,
    title: '',
    restart: null,
    listeners: new Set(),
  }
  runtimes.set(id, runtime)
  return runtime
}

export function updateTerminalRuntime(
  runtime: TerminalRuntime,
  patch: Partial<Pick<TerminalRuntime, 'terminal' | 'fit' | 'nativeSessionId' | 'status' | 'error' | 'shellInfo' | 'title' | 'restart'>>,
) {
  Object.assign(runtime, patch)
  notifyTerminalRuntime(runtime)
}

export function notifyTerminalRuntime(runtime: TerminalRuntime) {
  runtime.listeners.forEach((listener) => listener())
}

export function subscribeTerminalRuntime(runtime: TerminalRuntime, listener: () => void) {
  runtime.listeners.add(listener)
  return () => {
    runtime.listeners.delete(listener)
  }
}

export function isTerminalRuntimeCurrent(runtime: TerminalRuntime) {
  return runtimes.get(runtime.id) === runtime
}

export function attachTerminalRuntime(runtime: TerminalRuntime, host: HTMLElement) {
  const terminal = runtime.terminal
  if (!terminal) return

  const element = terminal.element
  if (element) {
    if (element.parentElement !== host) {
      host.replaceChildren(element)
    }
  } else {
    host.innerHTML = ''
    terminal.open(host)
  }
  runtime.fit?.fit()
}

export function destroyTerminalRuntime(id: string) {
  const runtime = runtimes.get(id)
  if (!runtime) return
  runtimes.delete(id)

  const sessionId = runtime.nativeSessionId
  runtime.nativeSessionId = null
  runtime.startToken += 1
  runtime.startPromise = null
  if (sessionId) {
    void terminalApi.kill(sessionId).catch(() => {})
  }

  runtime.dataDisposable?.dispose()
  runtime.dataDisposable = null
  runtime.unlisteners.forEach((unlisten) => unlisten())
  runtime.unlisteners = []
  runtime.terminal?.dispose()
  runtime.terminal = null
  runtime.fit = null
  runtime.listeners.clear()
}
