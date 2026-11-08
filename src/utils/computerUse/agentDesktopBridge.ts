import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import type { AgentDesktopInput } from '../../vendor/computer-use-mcp/agentDesktopProtocol.js'
import type { CuCallToolResult } from '../../vendor/computer-use-mcp/toolCalls.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getCwd } from '../cwd.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { isComputerUseEnabledForDispatch } from './skillGate.js'
import { resolveAgentDesktopBinary, type AgentDesktopBinaryOptions } from './agentDesktopBinary.js'
import { AgentDesktopInputError, agentDesktopAction, isAgentDesktopHelp, prepareAgentDesktopArguments, validateAgentDesktopInput } from './agentDesktopArguments.js'
import { AgentDesktopProcessError, runAgentDesktopProcess, type AgentDesktopRunner } from './agentDesktopProcess.js'
import {
  agentDesktopToolResult,
  cursorFeedback,
  parseAgentDesktopProcessEnvelope,
  type AgentDesktopCursorConfiguration,
  type AgentDesktopEnvelope,
} from './agentDesktopResult.js'

export { resolveAgentDesktopBinary } from './agentDesktopBinary.js'

export type AgentDesktopBackendOptions = AgentDesktopBinaryOptions & {
  configRoot?: string
  environment?: NodeJS.ProcessEnv
  getSessionId?: () => string
  getAgentId?: () => string | undefined
  runner?: AgentDesktopRunner
  timeoutMs?: number
  maxOutputBytes?: number
  cursorLabel?: string
  cursorAccent?: string
  getCwd?: () => string
  isDisabled?: () => boolean
  registerCleanup?: typeof registerCleanup
}

export type AgentDesktopStatus = {
  available: boolean
  binaryPath: string | null
  reason: string | null
  message?: string
  detail?: unknown
}

type CursorWarning = NonNullable<AgentDesktopCursorConfiguration['warning']>
type NativeSession = {
  id: string
  overlayEnabled: boolean | 'unknown'
  cursorRequested: boolean
  configuringCursor?: Promise<CursorWarning | undefined>
  startEnvelope: AgentDesktopEnvelope
}
const unscopedCommands = new Set(['status', 'permissions', 'version', 'skills'])
const checkSessionStorage = '--check-session-storage'

class AgentDesktopNativeError extends Error {
  constructor(readonly envelope: AgentDesktopEnvelope) {
    super(typeof envelope.error?.message === 'string' ? envelope.error.message : 'Native desktop command failed')
  }
}

function environment(options: AgentDesktopBackendOptions, stateRoot: string): NodeJS.ProcessEnv {
  const value = { ...(options.environment ?? process.env) }
  for (const key of Object.keys(value)) {
    if (key.toUpperCase().startsWith('AGENT_DESKTOP_')) delete value[key]
  }
  return {
    ...value,
    AGENT_DESKTOP_HOME: stateRoot,
    AGENT_DESKTOP_CURSOR_FEEDBACK: '1',
    // Keep the cue visible while the model observes and plans its next action.
    // Normal turn cleanup disables it immediately.
    ...(isWindows(options) ? { AGENT_DESKTOP_CURSOR_IDLE_MS: '45000' } : {}),
  }
}

function isWindows(options: AgentDesktopBackendOptions): boolean {
  return (options.platform ?? process.platform) === 'win32'
}

function stateRoot(options: AgentDesktopBackendOptions): string {
  const leaf = isWindows(options) ? 'agent-desktop-private' : 'agent-desktop'
  return path.resolve(options.configRoot ?? getClaudeConfigHomeDir(), '.runtime', leaf)
}

function agentIdentity(value: string): string {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : `agent-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function bridgeError(command: string, error: unknown, dispatched: boolean): CuCallToolResult {
  if (error instanceof AgentDesktopNativeError) return { isError: true, content: [{ type: 'text', text: JSON.stringify(error.envelope) }] }
  const processError = error instanceof AgentDesktopProcessError ? error : undefined
  const notDelivered = error instanceof AgentDesktopInputError || (processError ? !processError.dispatched : !dispatched)
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({
      ok: false,
      command,
      error: {
        code: error instanceof AgentDesktopInputError ? 'INVALID_ARGS' : processError?.reason === 'disabled' ? 'POLICY_DENIED' : processError?.reason === 'timeout' ? 'TIMEOUT' : 'ACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        disposition: { delivery: notDelivered ? 'not_delivered' : 'delivery_uncertain', retry: notDelivered ? 'safe' : 'unsafe' },
      },
    }) }],
  }
}

async function rawCommand(
  options: AgentDesktopBackendOptions,
  binaryPath: string,
  args: string[],
  signal?: AbortSignal,
) {
  const root = stateRoot(options)
  // On Windows the native CLI must create the leaf with its private DACL.
  if (!isWindows(options)) await mkdir(root, { recursive: true, mode: 0o700 })
  const cwd = (options.getCwd ?? getCwd)()
  if (options.isDisabled?.()) throw new AgentDesktopProcessError('Computer Use was disabled before dispatch. No command was dispatched.', 'disabled', false)
  if (signal?.aborted) throw new AgentDesktopProcessError('Desktop command was cancelled before dispatch', 'aborted', false)
  return (options.runner ?? runAgentDesktopProcess)({
    binaryPath,
    args,
    env: environment(options, root),
    cwd,
    signal,
    timeoutMs: Math.min(300_000, Math.max(1, options.timeoutMs ?? 90_000)),
    maxOutputBytes: Math.min(64 * 1024 * 1024, Math.max(1024, options.maxOutputBytes ?? 32 * 1024 * 1024)),
  })
}

export async function getAgentDesktopStatus(options: AgentDesktopBackendOptions = {}): Promise<AgentDesktopStatus> {
  const binaryPath = await resolveAgentDesktopBinary(options)
  if (!binaryPath) return { available: false, binaryPath: null, reason: 'binary_missing' }
  try {
    const args = isWindows(options) ? ['status', checkSessionStorage] : ['status']
    const result = await rawCommand({ ...options, timeoutMs: options.timeoutMs ?? 10_000 }, binaryPath, args)
    const envelope = parseAgentDesktopProcessEnvelope(result, 'status')
    if (!envelope.ok || result.exitCode !== 0) {
      const message = envelope.error?.message
      return { available: false, binaryPath, reason: 'runtime_unavailable', ...(typeof message === 'string' ? { message } : {}), detail: envelope.error ?? envelope }
    }
    const detail = envelope.data
    if (envelope.command !== 'status' || !detail || !Array.isArray(detail.supported_surfaces)) {
      return { available: false, binaryPath, reason: 'invalid_response', detail: envelope }
    }
    const permissions = detail?.permissions as { accessibility?: { state?: string } } | undefined
    if (permissions?.accessibility?.state === 'denied') return { available: false, binaryPath, reason: 'accessibility_denied', detail }
    if (Array.isArray(detail?.supported_surfaces) && detail.supported_surfaces.length === 0) {
      return { available: false, binaryPath, reason: 'accessibility_bus_unavailable', detail }
    }
    const storage = detail.session_storage as { ready?: boolean; message?: string } | undefined
    if (isWindows(options) && storage?.ready !== true) {
      return {
        available: false,
        binaryPath,
        reason: 'session_storage_unavailable',
        ...(typeof storage?.message === 'string' ? { message: storage.message } : {}),
        detail,
      }
    }
    return { available: true, binaryPath, reason: null, detail }
  } catch (error) {
    return { available: false, binaryPath, reason: error instanceof AgentDesktopProcessError ? error.reason : 'invalid_response', detail: error instanceof Error ? error.message : String(error) }
  }
}

export function createAgentDesktopBackend(provided: AgentDesktopBackendOptions = {}) {
  let closing = false
  const isDisabled = provided.isDisabled ?? (() => !isComputerUseEnabledForDispatch())
  const options = { ...provided, isDisabled: () => closing || isDisabled() }
  const sessions = new Map<string, Promise<NativeSession>>()
  const ownedSessions = new Map<string, NativeSession>()
  const activeExecutions = new Map<Promise<CuCallToolResult>, string>()
  const shutdownController = new AbortController()
  let unregisterShutdown: (() => void) | undefined
  let shutdownTask: Promise<void> | undefined
  const binary = () => resolveAgentDesktopBinary(options)
  const currentProductSession = options.getSessionId ?? getSessionId
  const currentAgent = options.getAgentId ?? (() => 'main')
  const cursorStyle = ['--fill', '#0075F2', '--rim', '#FFFFFF', '--accent', options.cursorAccent ?? '#4D9EFF', '--size', '1']
  const cursorLabel = options.cursorLabel ?? (isWindows(options) ? 'Agent' : undefined)
  if (cursorLabel) cursorStyle.push('--label', cursorLabel)

  const disableSessionCursor = async (binaryPath: string, session: NativeSession, signal?: AbortSignal) => {
    if (session.overlayEnabled === false) return
    session.overlayEnabled = 'unknown'
    const result = await rawCommand({ ...options, getCwd: () => stateRoot(options), isDisabled: undefined, timeoutMs: 2_000 }, binaryPath, ['--session', session.id, 'cursor-overlay', 'disable'], signal)
    const response = parseAgentDesktopProcessEnvelope(result, 'cursor-overlay')
    if (!response.ok || result.exitCode !== 0) throw new AgentDesktopNativeError(response)
    session.overlayEnabled = false
  }

  const configureSessionCursor = (
    binaryPath: string,
    session: NativeSession,
    signal: AbortSignal,
  ): Promise<CursorWarning | undefined> => {
    session.configuringCursor ??= (async () => {
      try {
        const result = await rawCommand({ ...options, timeoutMs: 2_000 }, binaryPath, [
          '--session', session.id, 'cursor-overlay', 'enable', '--multi-agent', ...cursorStyle,
        ], signal)
        const envelope = parseAgentDesktopProcessEnvelope(result, 'cursor-overlay')
        if (!envelope.ok || result.exitCode !== 0) throw new AgentDesktopNativeError(envelope)
        session.overlayEnabled = true
      } catch (error) {
        session.overlayEnabled = 'unknown'
        if (error instanceof AgentDesktopProcessError && (error.reason === 'disabled' || error.reason === 'aborted')) throw error
        const nativeCode = error instanceof AgentDesktopNativeError ? error.envelope.error?.code : undefined
        return {
          code: typeof nativeCode === 'string' ? nativeCode : 'CURSOR_CONFIGURATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        }
      } finally {
        session.configuringCursor = undefined
      }
    })()
    return session.configuringCursor
  }

  const startSession = async (binaryPath: string, productSession: string, signal?: AbortSignal, args: string[] = []): Promise<NativeSession> => {
    unregisterShutdown ??= (options.registerCleanup ?? registerCleanup)(shutdown, { timeoutMs: 4_500 })
    const suppliedName = args.some(arg => arg === '--name' || arg.startsWith('--name='))
    const startArgs = ['session', 'start', ...args]
    if (!suppliedName) startArgs.push('--name', `cc-haha-${productSession}`.slice(0, 128))
    if (args.includes('--cursor') && !args.includes('--multi-agent')) startArgs.push('--multi-agent')
    if (args.includes('--multi-agent') && !args.includes('--cursor')) startArgs.push('--cursor')
    const result = await rawCommand(options, binaryPath, startArgs, signal)
    const envelope = parseAgentDesktopProcessEnvelope(result, 'session')
    if (!envelope.ok || result.exitCode !== 0) throw new AgentDesktopNativeError(envelope)
    const id = envelope.data?.session_id
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('agent-desktop returned an invalid session id')
    const session: NativeSession = { id, overlayEnabled: 'unknown', cursorRequested: true, startEnvelope: envelope }
    ownedSessions.set(id, session)
    return session
  }

  const sessionFor = (binaryPath: string, productSession: string, signal?: AbortSignal) => {
    let pending = sessions.get(productSession)
    if (!pending) {
      pending = startSession(binaryPath, productSession, signal)
      sessions.set(productSession, pending)
      void pending.catch(() => { if (sessions.get(productSession) === pending) sessions.delete(productSession) })
    }
    return pending
  }

  const executeCommand = async (input: AgentDesktopInput, productSession: string, signal?: AbortSignal, agentId?: string): Promise<CuCallToolResult> => {
    signal = signal ? AbortSignal.any([signal, shutdownController.signal]) : shutdownController.signal
    let dispatched = false
    let artifactRoot: string | undefined
    try {
      validateAgentDesktopInput(input)
      if (signal?.aborted) throw new AgentDesktopProcessError('Desktop command was cancelled before dispatch', 'aborted', false)
      const binaryPath = await binary()
      if (!binaryPath) throw new Error('The bundled agent-desktop binary is unavailable. Build or reinstall the native desktop runtime.')
      const help = isAgentDesktopHelp(input)
      const action = agentDesktopAction(input)
      if (help || unscopedCommands.has(input.command) || (input.command === 'session' && ['list', 'gc'].includes(action?.name ?? 'list'))) {
        const selected = !help && input.command === 'status' ? await sessions.get(productSession) : undefined
        const commandArgs = [...(input.args ?? [])]
        if (!help && input.command === 'status' && isWindows(options) && !commandArgs.includes(checkSessionStorage)) commandArgs.unshift(checkSessionStorage)
        const args = selected ? ['--session', selected.id, input.command, ...commandArgs] : [input.command, ...commandArgs]
        dispatched = true
        const result = await rawCommand(options, binaryPath, args, signal)
        return await agentDesktopToolResult(result, stateRoot(options), help, input.command)
      }

      if (input.command === 'session' && action?.name === 'start') {
        const previous = sessions.get(productSession)
        const previousSession = await previous
        if (previousSession) await disableSessionCursor(binaryPath, previousSession, signal)
        const pending = startSession(binaryPath, productSession, signal, input.args!.filter((_, index) => index !== action.index))
        sessions.set(productSession, pending)
        void pending.catch(() => {
          if (sessions.get(productSession) === pending) {
            if (previous) sessions.set(productSession, previous)
            else sessions.delete(productSession)
          }
        })
        const session = await pending
        const warning = await configureSessionCursor(binaryPath, session, signal)
        const report = cursorFeedback('', { configured: warning ? null : true, warning })
        return { content: [{ type: 'text', text: JSON.stringify({ ...session.startEnvelope, cursor_overlay: report }) }] }
      }
      const session = await sessionFor(binaryPath, productSession, signal)
      const identity = agentIdentity(agentId ?? currentAgent() ?? 'main')
      const sessionCursorCommand = input.command === 'cursor-overlay'
      const prefix = ['--session', session.id]
      if (!sessionCursorCommand) prefix.push('--agent-id', identity)
      if (input.headed) prefix.push('--headed')
      artifactRoot = path.join(stateRoot(options), 'artifacts', session.id, randomUUID())
      const args = await prepareAgentDesktopArguments(input, session.id, artifactRoot)
      let warning: CursorWarning | undefined
      if (session.cursorRequested && session.overlayEnabled !== true && !sessionCursorCommand && input.command !== 'session' && input.command !== 'trace') {
        warning = await configureSessionCursor(binaryPath, session, signal)
      }
      if (sessionCursorCommand) {
        session.overlayEnabled = 'unknown'
        if (action?.name === 'enable' && !args.includes('--multi-agent')) args.splice(action.index + 1, 0, '--multi-agent')
      }
      dispatched = true
      const result = await rawCommand(options, binaryPath, [...prefix, input.command, ...args], signal)
      if (sessionCursorCommand && result.exitCode === 0) {
        const envelope = parseAgentDesktopProcessEnvelope(result, 'cursor-overlay')
        if (envelope.ok && (action?.name === 'enable' || action?.name === 'disable')) {
          session.cursorRequested = action.name === 'enable'
          session.overlayEnabled = session.cursorRequested
        }
      }
      const configured = session.overlayEnabled === 'unknown' ? null : session.overlayEnabled
      const response = await agentDesktopToolResult(result, artifactRoot, false, input.command, { configured, warning })
      if (!response.isError && input.command === 'session' && action?.name === 'end') {
        sessions.delete(productSession)
        ownedSessions.delete(session.id)
      }
      return response
    } catch (error) {
      return bridgeError(input?.command ?? 'desktop', error, dispatched)
    } finally {
      if (artifactRoot) await rmdir(artifactRoot).catch(() => {})
    }
  }

  const execute = (input: AgentDesktopInput, signal?: AbortSignal, agentId?: string): Promise<CuCallToolResult> => {
    const productSession = currentProductSession()
    const pending = executeCommand(input, productSession, signal, agentId)
    activeExecutions.set(pending, productSession)
    void pending.then(() => activeExecutions.delete(pending), () => activeExecutions.delete(pending))
    return pending
  }

  function shutdown(): Promise<void> {
    if (shutdownTask) return shutdownTask
    closing = true
    shutdownController.abort()
    unregisterShutdown?.()
    unregisterShutdown = undefined
    shutdownTask = (async () => {
      await Promise.allSettled(activeExecutions.keys())
      await Promise.allSettled([...sessions.values()])
      const binaryPath = binary()
      if (!binaryPath) return
      const ending = new Set<string>()
      const end = async (session: NativeSession) => {
        if (ending.has(session.id)) return
        ending.add(session.id)
        const result = await rawCommand({ ...options, getCwd: () => stateRoot(options), isDisabled: undefined, timeoutMs: 1_500 }, binaryPath, ['--session', session.id, 'session', 'end', session.id])
        const envelope = parseAgentDesktopProcessEnvelope(result, 'session')
        if (!envelope.ok || result.exitCode !== 0) throw new AgentDesktopNativeError(envelope)
      }
      await Promise.allSettled([...ownedSessions.values()].map(end))
      sessions.clear()
      ownedSessions.clear()
    })()
    return shutdownTask
  }

  return {
    execute,
    shutdown,
    status: () => getAgentDesktopStatus(options),
    permissions: () => execute({ command: 'permissions' }),
    async cleanup(): Promise<void> {
      const productSession = currentProductSession()
      const active = [...activeExecutions].filter(([, owner]) => owner === productSession).map(([execution]) => execution)
      await Promise.allSettled(active)
      const pending = sessions.get(productSession)
      if (!pending) return
      const session = await pending.catch(() => undefined)
      const binaryPath = await binary()
      if (!session || !binaryPath || !session.overlayEnabled) return
      await disableSessionCursor(binaryPath, session)
    },
  }
}
