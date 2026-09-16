import { getDesktopHost } from '../lib/desktopHost'

export type TerminalSpawnResult = {
  session_id: number
  shell: string
  cwd: string
}

export type TerminalOutputPayload = {
  requestId?: string
  session_id: number
  data: string
}

export type TerminalExitPayload = {
  requestId?: string
  session_id: number
  code: number
  signal?: string | null
}

type Unlisten = () => void

function getTerminalHost() {
  const host = getDesktopHost()
  if (!host.capabilities.terminal) {
    throw new Error('Terminal is available in the desktop app runtime.')
  }
  return host.terminal
}

export const terminalApi = {
  isAvailable: () => getDesktopHost().capabilities.terminal,

  spawn(input: { cols: number; rows: number; cwd?: string; requestId?: string }) {
    const host = getTerminalHost()
    if (host.supportsStartupCorrelation) return host.spawn(input)
    // The Web renderer can hot-update before the native preload/main process.
    // Old strict IPC validators reject newly added keys, even optional ones.
    const { requestId: _requestId, ...legacyInput } = input
    return host.spawn(legacyInput)
  },

  write(sessionId: number, data: string) {
    return getTerminalHost().write(sessionId, data)
  },

  resize(sessionId: number, cols: number, rows: number) {
    return getTerminalHost().resize(sessionId, cols, rows)
  },

  kill(sessionId: number) {
    return getTerminalHost().kill(sessionId)
  },

  async onOutput(handler: (payload: TerminalOutputPayload) => void): Promise<Unlisten> {
    return getTerminalHost().onOutput(handler)
  },

  async onExit(handler: (payload: TerminalExitPayload) => void): Promise<Unlisten> {
    return getTerminalHost().onExit(handler)
  },

  getBashPath() {
    return getTerminalHost().getBashPath()
  },

  setBashPath(path: string | null) {
    return getTerminalHost().setBashPath(path)
  },
}
