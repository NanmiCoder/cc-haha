import type { CuCallToolResult } from './toolCalls.js'

export type ReplContent = { type: 'text', text: string } | { type: 'image', data: string, mimeType: string }

/** Only JSON crosses the untrusted kernel boundary. No native/host objects. */
export type ReplInput =
  | { type: 'init', bootstrap: string }
  | { type: 'ping', nonce: number }
  | { type: 'run', cellId: number, code: string }
  | { type: 'response', cellId: number, requestId: number, result?: unknown, error?: string }

export type ReplOutput =
  | { type: 'ready' }
  | { type: 'pong', nonce: number }
  | { type: 'invoke', cellId: number, requestId: number, name: string, args: unknown }
  | { type: 'emit', cellId: number, content: ReplContent }
  | { type: 'done', cellId: number, error?: string }

export type ReplInvoke = (name: string, args: unknown, signal: AbortSignal) => Promise<CuCallToolResult>

export interface ComputerUseReplRuntime {
  run(options: {
    code: string
    timeoutMs: number
    signal?: AbortSignal
    isAborted?: () => boolean
  }, invoke: ReplInvoke): Promise<CuCallToolResult>
  reset(): Promise<void>
}

export const REPL_MAX_CODE_BYTES = 256 * 1024
export const REPL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export const REPL_MAX_ACTIONS = 256
