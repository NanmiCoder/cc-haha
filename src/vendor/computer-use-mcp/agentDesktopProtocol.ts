import type { CuCallToolResult } from './toolCalls.js'

export const AGENT_DESKTOP_COMMANDS = [
  'snapshot', 'find', 'get', 'is', 'screenshot', 'list-surfaces',
  'click', 'double-click', 'triple-click', 'right-click', 'type', 'set-value',
  'clear', 'focus', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse',
  'scroll', 'scroll-to', 'press', 'hover', 'drag', 'mouse-move', 'mouse-click',
  'mouse-wheel', 'key-down', 'key-up', 'mouse-down', 'mouse-up',
  'launch', 'close-app', 'list-apps', 'list-windows', 'list-displays',
  'focus-window', 'resize-window', 'move-window', 'minimize', 'maximize', 'restore',
  'open-system-surface', 'list-notifications', 'dismiss-notification',
  'dismiss-all-notifications', 'notification-action', 'clipboard-get',
  'clipboard-set', 'clipboard-clear', 'wait', 'session', 'trace', 'cursor-overlay',
  'status', 'permissions', 'version', 'batch', 'skills',
] as const

export type AgentDesktopInput = {
  command: string
  args?: string[]
  headed?: boolean
}

export interface AgentDesktopBackend {
  execute(input: AgentDesktopInput, signal?: AbortSignal, agentId?: string): Promise<CuCallToolResult>
  cleanup(): Promise<void>
}

export function parseAgentDesktopInput(value: unknown): AgentDesktopInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('desktop requires an object with command, optional args, and optional headed')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['command', 'args', 'headed'].includes(key))
    || typeof input.command !== 'string'
    || !(AGENT_DESKTOP_COMMANDS as readonly string[]).includes(input.command)
    || (input.args !== undefined && (!Array.isArray(input.args)
      || input.args.length > 256
      || input.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))))
    || (input.headed !== undefined && typeof input.headed !== 'boolean')
    || JSON.stringify(input).length > 1_048_576) {
    throw new Error('Invalid desktop command or arguments; args must be an array of CLI argument strings')
  }
  return input as AgentDesktopInput
}
