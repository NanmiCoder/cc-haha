import { isTauriRuntime } from '../lib/desktopRuntime'

export type TerminalSpawnResult = {
  session_id: number
  shell: string
  cwd: string
}

export type TerminalOutputPayload = {
  session_id: number
  data: string
}

export type TerminalExitPayload = {
  session_id: number
  code: number
  signal?: string | null
}

type Unlisten = () => void

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('Terminal is available in the desktop app runtime.')
  }
  const api = await import('@tauri-apps/api/core')
  return api.invoke<T>(command, args)
}

export const terminalApi = {
  isAvailable: isTauriRuntime,

  spawn(input: { cols: number; rows: number; cwd?: string }) {
    return invoke<TerminalSpawnResult>('terminal_spawn', input)
  },

  write(sessionId: number, data: string) {
    return invoke<void>('terminal_write', { sessionId, data })
  },

  resize(sessionId: number, cols: number, rows: number) {
    return invoke<void>('terminal_resize', { sessionId, cols, rows })
  },

  kill(sessionId: number) {
    return invoke<void>('terminal_kill', { sessionId })
  },

  async onOutput(handler: (payload: TerminalOutputPayload) => void): Promise<Unlisten> {
    const events = await import('@tauri-apps/api/event')
    return events.listen<TerminalOutputPayload>('terminal-output', (event) => handler(event.payload))
  },

  async onExit(handler: (payload: TerminalExitPayload) => void): Promise<Unlisten> {
    const events = await import('@tauri-apps/api/event')
    return events.listen<TerminalExitPayload>('terminal-exit', (event) => handler(event.payload))
  },

  getBashPath() {
    return invoke<string | null>('get_terminal_bash_path', undefined)
  },

  setBashPath(path: string | null) {
    return invoke<void>('set_terminal_bash_path', { path })
  },
}
