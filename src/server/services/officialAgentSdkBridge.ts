import { OfficialAgentSdkUsage, mergeOfficialAgentSdkModelUsage } from './officialAgentSdkUsage.js'
import { normalizeOfficialAgentSdkToolContent, normalizeOfficialAgentSdkToolName } from '../../shared/officialAgentSdkToolNames.js'
import { OfficialAgentSdkSideQuestions } from './officialAgentSdkSideQuestions.js'
import { createOfficialAgentSdkDialogs } from './officialAgentSdkDialogs.js'
import { createOfficialAgentSdkNetwork } from './officialAgentSdkNetwork.js'
import { createOfficialAgentSdkMessageIdentity } from './officialAgentSdkMessageIdentity.js'
import { createOfficialUltracodeController } from './officialAgentSdkUltracode.js'
import { OFFICIAL_SDK_DIALOG_TOOL } from '../../shared/officialAgentSdkDialogs.js'
import { release } from 'node:os'
import { AGENT_PROFILES } from '../../utils/agentProfile.js'
import { buildLeanSystemPrompt } from '../../constants/leanPrompt.js'
import { isAbsolute } from 'node:path'
import { createOfficialAgentSdkSettingsFile, officialAgentSdkProviderSettings, parseOfficialAgentSdkLaunchOptions, type OfficialAgentSdkLaunchOptions } from './officialAgentSdkConfiguration.js'
import type {
  CanUseTool,
  ModelUsage,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk/core'

export type OfficialAgentSdkConfig = {
  transport: 'websocket' | 'stdio'
  sdkUrl?: string
  hostSessionId: string
  sessionId: string
  resume: boolean
  resumeFrom?: string
  forkSession?: boolean
  resumeSessionAt?: string
  launchOptions: OfficialAgentSdkLaunchOptions
  persistSession: boolean
  cwd: string
  model?: string
  effort?: Options['effort']
  thinking?: 'enabled' | 'adaptive' | 'disabled'
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
  env: NodeJS.ProcessEnv
}

export type OfficialAgentSdkBridge = {
  receive(payload: string): Promise<void>
  close(): void
  ready: Promise<void>
  done: Promise<void>
}

type WireMessage = Record<string, unknown>
export type OfficialAgentSdkExtensions = Pick<Options, 'mcpServers' | 'hooks' | 'agents' | 'toolAliases' | 'allowedTools'> & {
  appendSystemPrompt?: string
  transformPrompt?(text: string, context?: { isHumanInput: boolean; humanText?: string }): Promise<string>
  configure?(context: { canUseTool: CanUseTool; options: Options; notify?(text: string): void }): void
  beforeUserMessage?(context?: { isHumanInput: boolean }): Promise<void>
  interrupt?(): Promise<void>
  stopTask?(taskId: string): Promise<boolean>
  backgroundTasks?(toolUseId?: string): Promise<boolean>
  usage?(): { totalCostUSD: number; modelUsage: Record<string, ModelUsage>; durationApiMs: number }
  onTurnEnd?(): Promise<void>
  close?(): Promise<void>
}
type BridgeDependencies = {
  extensions?: OfficialAgentSdkExtensions
  query: typeof query
  send(message: WireMessage): void
}

const permissionModes = new Set<PermissionMode>([
  'default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto',
])
const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function permissionMode(value: unknown): PermissionMode {
  if (typeof value !== 'string' || !permissionModes.has(value as PermissionMode)) {
    throw new Error('Unsupported official Agent SDK permission mode')
  }
  return value as PermissionMode
}

/** The SDK backend accepts only its own launch contract, never arbitrary CLI flags. */
export function parseOfficialAgentSdkArgs(
  args: string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): OfficialAgentSdkConfig {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const valueOptions = new Set(['--sdk-url', '--session-id', '--resume', '--model', '--effort', '--thinking', '--permission-mode', '--host-session-id', '--resume-session-at', '--launch-options'])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--stdio' || arg === '--fork-session' || arg === '--dangerously-skip-permissions' || arg === '--allow-dangerously-skip-permissions' || arg === '--no-session-persistence') {
      flags.add(arg)
      continue
    }
    if (!valueOptions.has(arg)) throw new Error(`Unsupported official Agent SDK argument: ${arg.split('=')[0]}`)
    const value = args[++index]
    if (!value || value.startsWith('--') || values.has(arg)) {
      throw new Error(`Missing or repeated official Agent SDK argument: ${arg}`)
    }
    values.set(arg, value)
  }
  const sessionId = values.get('--session-id') ?? values.get('--resume')
  const resumeFrom = values.get('--resume')
  const forkSession = flags.has('--fork-session')
  const hostSessionId = values.get('--host-session-id') ?? sessionId
  if (!sessionId || !sessionIdPattern.test(sessionId) || !hostSessionId ||
    !sessionIdPattern.test(hostSessionId.replace(/^side-/, '')) ||
    (values.has('--session-id') && resumeFrom && !forkSession) ||
    (forkSession && (!values.has('--session-id') || !resumeFrom || (!sessionIdPattern.test(resumeFrom) && !isAbsolute(resumeFrom))))) {
    throw new Error('An official Agent SDK session requires valid native and host identities; forks require a source and a new UUID')
  }
  const resumeSessionAt = values.get('--resume-session-at')
  if (resumeSessionAt && (!resumeFrom || !sessionIdPattern.test(resumeSessionAt))) throw new Error('Invalid SDK resume point')
  const transport = flags.has('--stdio') ? 'stdio' : 'websocket'
  let sdkUrl: URL | undefined
  if (transport === 'stdio') {
    if (values.has('--sdk-url')) throw new Error('A stdio SDK session cannot also use a WebSocket')
  } else {
    try { sdkUrl = new URL(values.get('--sdk-url') ?? '') } catch { throw new Error('An authenticated local SDK WebSocket URL is required') }
    if (sdkUrl.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(sdkUrl.hostname) ||
      sdkUrl.pathname !== `/sdk/${hostSessionId}` || !sdkUrl.searchParams.get('token') || sdkUrl.username || sdkUrl.password) {
      throw new Error('An authenticated local SDK WebSocket URL is required')
    }
  }
  const effort = values.get('--effort')
  if (effort && !efforts.has(effort)) throw new Error('Unsupported official Agent SDK effort')
  const thinking = values.get('--thinking')
  if (thinking && !['enabled', 'adaptive', 'disabled'].includes(thinking)) {
    throw new Error('Unsupported official Agent SDK thinking mode')
  }
  const skipPermissions = flags.has('--dangerously-skip-permissions')
  const mode = skipPermissions ? 'bypassPermissions' : permissionMode(values.get('--permission-mode') ?? 'default')
  const allowSkip = skipPermissions || flags.has('--allow-dangerously-skip-permissions')
  if (mode === 'bypassPermissions' && !allowSkip) {
    throw new Error('Bypass mode requires the explicit skip-permissions launch flag')
  }
  const launchOptions = parseOfficialAgentSdkLaunchOptions(values.get('--launch-options'))
  if (launchOptions.agentProfile === 'lean' && (mode === 'plan' || forkSession || resumeSessionAt)) throw new Error('Lean sessions do not support plan mode, forks or partial resumes')
  if (!allowSkip && Object.values(launchOptions.agents ?? {}).some(agent => agent.permissionMode === 'bypassPermissions')) throw new Error('Agent permission bypass requires the explicit launch flag')
  return {
    transport,
    sdkUrl: sdkUrl?.toString(),
    sessionId,
    hostSessionId,
    resume: Boolean(resumeFrom),
    resumeFrom,
    forkSession,
    resumeSessionAt,
    launchOptions,
    persistSession: !flags.has('--no-session-persistence'),
    cwd,
    model: values.get('--model'),
    effort: effort as Options['effort'],
    thinking: thinking as OfficialAgentSdkConfig['thinking'],
    permissionMode: mode,
    allowDangerouslySkipPermissions: allowSkip,
    env,
  }
}

/** Keep queued desktop prompts here so an interrupt can revoke them before SDK dispatch. */
class TurnInput implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = []
  private active = false
  private paused = false
  private ended = false
  private wake: (() => void) | undefined
  constructor(private readonly onDispatch: (message: SDKUserMessage) => void = () => {}) {}

  push(message: SDKUserMessage): void {
    if (this.ended) throw new Error('The official Agent SDK session has closed')
    this.pending.push(message)
    this.notify()
  }

  finishTurn(): void {
    this.active = false
    this.notify()
  }

  pauseAndClear(): void {
    this.paused = true
    this.pending = []
  }

  resume(): void {
    this.paused = false
    this.notify()
  }

  close(): void {
    this.ended = true
    this.pending = []
    this.notify()
  }

  private notify(): void {
    this.wake?.()
    this.wake = undefined
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.ended) {
      if (!this.active && !this.paused && this.pending.length > 0) {
        this.active = true
        const message = this.pending.shift()!
        this.onDispatch(message)
        yield message
      } else {
        await new Promise<void>(resolve => { this.wake = resolve })
      }
    }
  }
}

type PendingPermission = {
  promise: Promise<PermissionResult>
  settle(result: PermissionResult): void
  input: Record<string, unknown>
  toolName: string
  suppressAlwaysAllowRule: boolean
}

/**
 * Adapts the official SDK's public API to the desktop's authenticated transport.
 * All provider traffic and product attribution remain owned by the official SDK.
 */
export function createOfficialAgentSdkBridge(
  config: OfficialAgentSdkConfig,
  dependencies: BridgeDependencies,
): OfficialAgentSdkBridge {
  const input = new TurnInput(message => {
    latestHuman = message.uuid ? humanPrompts.get(message.uuid) : undefined
  })
  const abortController = new AbortController()
  const permissions = new Map<string, PendingPermission>()
  const sideQuestions = new OfficialAgentSdkSideQuestions(dependencies.query)
  const context: unknown[] = []
  const contextIds: (string | undefined)[] = []
  const identity = createOfficialAgentSdkMessageIdentity()
  let latestHuman: { text: string; uuid: string } | undefined
  const humanPrompts = new Map<string, { text: string; uuid: string }>()
  const usage = new OfficialAgentSdkUsage()
  let currentModel = config.model
  let resumeAt: string | undefined
  let closed = false
  let sdk: Query | undefined
  let interrupting = false
  let ending = false
  let extensionClose: Promise<void> | undefined
  let drainTimeout: ReturnType<typeof setTimeout> | undefined

  function send(message: WireMessage): void {
    if (!closed) dependencies.send(message.type === 'system' || message.type === 'conversation_reset'
      ? { ...message, cc_haha_agent_sdk: true } : message)
  }

  function retract(uuids: unknown, edit?: { text: string; uuid: string }): void {
    if (closed) return
    const ids = identity.expand(uuids)
    if (ids.length) {
      const removed = new Set(ids)
      for (let index = contextIds.length - 1; index >= 0; index--) {
        if (contextIds[index] && removed.has(contextIds[index]!)) {
          contextIds.splice(index, 1)
          context.splice(index, 1)
        }
      }
    }
    if (ids.length || edit) send({
      type: 'system', subtype: 'official_sdk_messages_retracted',
      ids, ...(edit ? { edit } : {}), uuid: crypto.randomUUID(), session_id: config.sessionId,
    })
  }

  function denyPermissions(message: string): void {
    for (const [requestId, pending] of permissions) {
      // The socket may already be gone. Delivery is best effort; revoking the
      // pending callback and terminating the SDK must not depend on it.
      try { send({ type: 'control_cancel_request', request_id: requestId }) } catch {}
      pending.settle({ behavior: 'deny', message, interrupt: true })
    }
  }

  function close(): void {
    if (closed) return
    denyPermissions('The desktop connection was closed')
    closed = true
    if (drainTimeout) clearTimeout(drainTimeout)
    input.close()
    sideQuestions.close()
    extensionClose ??= Promise.resolve().then(() => dependencies.extensions?.close?.())
    void extensionClose.catch(() => undefined)
    abortController.abort()
    try { sdk?.close() } catch {
      // The abort controller has already revoked the process. A second close
      // racing its exit must not prevent the host from finishing cleanup.
    }
  }

  const canUseTool: CanUseTool = (toolName, toolInput, options) => {
    if (closed || interrupting || options.signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: 'The request was cancelled', interrupt: true })
    }
    const existing = permissions.get(options.requestId)
    if (existing) return existing.promise
    let resolvePermission!: (result: PermissionResult) => void
    const promise = new Promise<PermissionResult>(resolve => { resolvePermission = resolve })
    const onAbort = () => {
      try { send({ type: 'control_cancel_request', request_id: options.requestId }) } catch {}
      pending.settle({ behavior: 'deny', message: 'The request was cancelled', interrupt: true })
    }
    const pending: PendingPermission = {
      promise,
      input: toolInput,
      toolName,
      suppressAlwaysAllowRule: options.suppressAlwaysAllowRule === true,
      settle(result) {
        if (permissions.get(options.requestId) !== pending) return
        permissions.delete(options.requestId)
        options.signal.removeEventListener('abort', onAbort)
        resolvePermission(result)
      },
    }
    permissions.set(options.requestId, pending)
    options.signal.addEventListener('abort', onAbort, { once: true })
    if (options.signal.aborted) onAbort()
    else {
      try {
        send({
          type: 'control_request',
          request_id: options.requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: normalizeOfficialAgentSdkToolName(toolName),
            native_tool_name: toolName,
            input: toolInput,
            tool_use_id: options.toolUseID,
            permission_suggestions: options.suggestions,
            blocked_path: options.blockedPath,
            decision_reason: options.decisionReason,
            title: options.title,
            display_name: options.displayName,
            description: options.description,
            agent_id: options.agentID,
            default_to_no: options.defaultToNo,
            suppress_always_allow_rule: options.suppressAlwaysAllowRule,
          },
        })
      } catch {
        pending.settle({ behavior: 'deny', message: 'The desktop permission prompt could not be delivered', interrupt: true })
        close()
      }
    }
    return promise
  }

  const { appendSystemPrompt, agentProfile, agentHooks, ...launchOptions } = config.launchOptions
  const lean = agentProfile === 'lean'
  const extensions = lean ? undefined : dependencies.extensions
  const append = [appendSystemPrompt, extensions?.appendSystemPrompt].filter(Boolean).join('\n\n')
  const settingsFile = createOfficialAgentSdkSettingsFile({ ...officialAgentSdkProviderSettings(config.env), ...(agentHooks ? { hooks: agentHooks } : {}) })
  const options: Options = {
    ...launchOptions,
    ...(extensions?.mcpServers ? { mcpServers: extensions.mcpServers } : {}),
    ...(extensions?.hooks ? { hooks: extensions.hooks } : {}),
    ...(extensions?.toolAliases ? { toolAliases: extensions.toolAliases } : {}),
    ...(extensions?.allowedTools ? { allowedTools: extensions.allowedTools } : {}),
    ...((extensions?.agents || launchOptions.agents) ? { agents: { ...extensions?.agents, ...launchOptions.agents } } : {}),
    abortController,
    cwd: config.cwd,
    env: {
      ...config.env,
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      CLAUDE_CODE_BG_TASKS_REPORT_RUNNING: '1',
    },
    ...(config.resume ? { resume: config.resumeFrom ?? config.sessionId } : {}),
    ...(!config.resume || config.forkSession ? { sessionId: config.sessionId } : {}),
    ...(config.forkSession ? { forkSession: true } : {}),
    ...(config.resumeSessionAt ? { resumeSessionAt: config.resumeSessionAt } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.thinking ? { thinking: { type: config.thinking } } : {}),
    ...(config.env.CC_HAHA_AGENT_SDK_EXECUTABLE
      ? { pathToClaudeCodeExecutable: config.env.CC_HAHA_AGENT_SDK_EXECUTABLE }
      : {}),
    permissionMode: config.permissionMode,
    allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
    canUseTool,
    ...createOfficialAgentSdkDialogs(canUseTool, {
      onRefusalResolved(event) {
        retract(event.retractedMessageUuids, event.choice === 'edit_prompt' && !event.retired ? latestHuman : undefined)
      },
    }),
    includePartialMessages: true,
    persistSession: config.persistSession,
    settingSources: ['user', 'project', 'local'],
    strictMcpConfig: lean,
    skills: 'all',
    tools: lean ? AGENT_PROFILES.lean.toolNames.filter(name => !Array.isArray(launchOptions.tools) || launchOptions.tools.includes(name))
      : launchOptions.tools ?? { type: 'preset', preset: 'claude_code' },
    settings: settingsFile.path,
    enableFileCheckpointing: true,
    agentProgressSummaries: true,
    systemPrompt: lean ? [...buildLeanSystemPrompt({ toolNames: AGENT_PROFILES.lean.toolNames, cwd: config.cwd,
      additionalWorkingDirectories: launchOptions.additionalDirectories, platform: process.platform, osVersion: release(),
      shell: config.env.SHELL ?? '', date: new Date().toISOString().slice(0, 10), memory: null }), ...(append ? [append] : [])].join('\n\n')
      : { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
  }
  try {
    extensions?.configure?.({ canUseTool, options, notify(text) {
      if (closed || ending || !text.trim()) return
      input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null,
        session_id: config.sessionId, uuid: crypto.randomUUID(), isSynthetic: true, isMeta: true })
    } })
    sdk = dependencies.query({ prompt: input, options })
  } catch (error) {
    settingsFile.close()
    close()
    throw error
  }
  const runtime = sdk
  const settingsRuntime = runtime as Query & { getSettings?(): Promise<unknown> }
  const ultracode = createOfficialUltracodeController({
    getModel: () => currentModel,
    getEffort: () => options.effort,
    env: config.env,
    eligible: !lean && config.transport === 'websocket' && !config.hostSessionId.startsWith('side-') &&
      !config.env.CC_HAHA_TEAM_WORKER,
    ...(typeof settingsRuntime.getSettings === 'function' ? { readSettings: () => settingsRuntime.getSettings!() } : {}),
    async applySettings(settings) {
      await runtime.applyFlagSettings(settings)
      if (settings.effortLevel) options.effort = settings.effortLevel
    },
  })
  const network = createOfficialAgentSdkNetwork(config.env, options, runtime, settingsFile.updateEnv)
  const ready = runtime.initializationResult().then(() => undefined)
  void ready.catch(() => undefined)

  function respondToPermission(message: WireMessage): void {
    const response = message.response
    if (!isRecord(response) || typeof response.request_id !== 'string') return
    const pending = permissions.get(response.request_id)
    if (!pending) return
    const decision = response.response
    if (response.subtype !== 'success' || !isRecord(decision)) {
      pending.settle({ behavior: 'deny', message: 'The desktop did not approve this request' })
      return
    }
    if (decision.behavior === 'deny') {
      pending.settle({
        behavior: 'deny',
        message: typeof decision.message === 'string' ? decision.message : 'The user declined this request',
        ...(decision.interrupt === true ? { interrupt: true } : {}),
      })
      return
    }
    if (
      decision.behavior !== 'allow' ||
      (decision.updatedInput !== undefined && !isRecord(decision.updatedInput)) ||
      (decision.updatedPermissions !== undefined &&
        (!Array.isArray(decision.updatedPermissions) || !decision.updatedPermissions.every(isRecord))) ||
      (pending.suppressAlwaysAllowRule && Array.isArray(decision.updatedPermissions) && decision.updatedPermissions.length > 0)
    ) {
      pending.settle({ behavior: 'deny', message: 'The desktop returned an invalid permission decision' })
      return
    }
    pending.settle({
      behavior: 'allow',
      updatedInput: isRecord(decision.updatedInput) ? decision.updatedInput : pending.input,
      ...(Array.isArray(decision.updatedPermissions)
        ? { updatedPermissions: decision.updatedPermissions.map(update => {
          // The visible card uses the app's tool name. Persistent grants must
          // still target the native MCP identity, never an unrelated tool.
          if (!isRecord(update) || !Array.isArray(update.rules)) return update
          return { ...update, rules: update.rules.map(rule => isRecord(rule) && rule.toolName === normalizeOfficialAgentSdkToolName(pending.toolName)
            ? { ...rule, toolName: pending.toolName } : rule) }
        }) as PermissionUpdate[] }
        : {}),
    })
  }

  async function control(message: WireMessage): Promise<void> {
    if (typeof message.request_id !== 'string' || !isRecord(message.request)) {
      throw new Error('Malformed official Agent SDK control request')
    }
    const request = message.request
    try {
      let response: unknown = {}
      if (lean && (['mcp_reconnect', 'mcp_toggle', 'rewind_files'].includes(String(request.subtype)) ||
        (request.subtype === 'mcp_set_servers' && isRecord(request.servers) && Object.keys(request.servers).length > 0) ||
        (request.subtype === 'set_permission_mode' && request.mode === 'plan'))) throw new Error('This control is unavailable in lean sessions')
      switch (request.subtype) {
        case 'update_network_environment':
          await network.update(request.variables)
          break
        case 'update_provider_credentials':
          if (Object.keys(request).some(key => !['subtype', 'apiKey'].includes(key))) throw new Error('Invalid SDK provider credential update')
          await network.updateCredentials(request.apiKey)
          break
        case 'initialize':
          if (Object.keys(request).some(key => key !== 'subtype')) {
            throw new Error('Runtime initialization options must be supplied at launch')
          }
          response = await runtime.initializationResult()
          break
        case 'interrupt':
          interrupting = true
          input.pauseAndClear()
          denyPermissions('The user interrupted this turn')
          try {
            const [receipt] = await Promise.all([runtime.interrupt(), extensions?.interrupt?.()])
            response = receipt ?? {}
          } finally {
            interrupting = false
            input.resume()
          }
          break
        case 'end_session':
          if (!ending) {
            ending = true
            interrupting = true
            input.pauseAndClear()
            denyPermissions('The desktop is ending this session')
            await Promise.all([runtime.interrupt(), extensions?.interrupt?.()])
            // Closing the public streaming input lets the SDK drain the final
            // result and transcript before exiting. Force-close only if that
            // documented lifecycle fails to finish within the host's budget.
            input.close()
            drainTimeout = setTimeout(close, 5_000)
          }
          break
        case 'set_model':
          if (request.model !== undefined && typeof request.model !== 'string') throw new Error('Invalid model')
          await runtime.setModel(request.model as string | undefined)
          currentModel = request.model as string | undefined
          options.model = currentModel
          break
        case 'set_permission_mode': {
          const mode = permissionMode(request.mode)
          if (mode === 'bypassPermissions' && !config.allowDangerouslySkipPermissions) {
            throw new Error('This session was not launched with permission bypass enabled')
          }
          await runtime.setPermissionMode(mode)
          options.permissionMode = mode
          // The desktop waits for both the acknowledged method and this state.
          send({ type: 'system', subtype: 'status', status: null, permissionMode: mode, uuid: crypto.randomUUID(), session_id: config.sessionId })
          break
        }
        case 'set_max_thinking_tokens':
          if (request.max_thinking_tokens !== null &&
            (typeof request.max_thinking_tokens !== 'number' || !Number.isInteger(request.max_thinking_tokens) || request.max_thinking_tokens < 0)) {
            throw new Error('Invalid thinking token limit')
          }
          await runtime.setMaxThinkingTokens(request.max_thinking_tokens as number | null)
          if (request.max_thinking_tokens === null) { delete options.thinking; delete options.maxThinkingTokens }
          else if (request.max_thinking_tokens === 0) { options.thinking = { type: 'disabled' }; delete options.maxThinkingTokens }
          else { options.thinking = { type: 'enabled', budgetTokens: request.max_thinking_tokens as number }; delete options.maxThinkingTokens }
          break
        case 'side_question':
          response = await sideQuestions.ask(request, { options, sessionId: config.sessionId, model: currentModel, resumeAt, context: [...context] })
          break
        case 'cancel_side_question':
          sideQuestions.cancel(request.question_id)
          break
        case 'supported_commands':
          response = { commands: await runtime.supportedCommands() }
          break
        case 'supported_models':
          response = { models: await runtime.supportedModels() }
          break
        case 'supported_agents':
          response = { agents: await runtime.supportedAgents() }
          break
        case 'get_ultracode':
          response = await ultracode.refreshState()
          break
        case 'set_ultracode':
          if (typeof request.enabled !== 'boolean') throw new Error('Invalid Ultracode state')
          response = await ultracode.setEnabled(request.enabled)
          break
        case 'mcp_status':
          response = { mcpServers: await runtime.mcpServerStatus() }
          break
        case 'mcp_reconnect':
        case 'mcp_toggle':
          if (typeof request.serverName !== 'string' || !request.serverName.trim()) throw new Error('Invalid MCP server name')
          if (request.subtype === 'mcp_toggle') {
            if (typeof request.enabled !== 'boolean') throw new Error('Invalid MCP enabled state')
            await runtime.toggleMcpServer(request.serverName, request.enabled)
          } else await runtime.reconnectMcpServer(request.serverName)
          break
        case 'mcp_set_servers':
          if (!isRecord(request.servers) || Object.values(request.servers).some(server => !isRecord(server))) throw new Error('Invalid MCP server configuration')
          // The extension server is part of the host, not a user-editable MCP entry.
          response = await runtime.setMcpServers({ ...request.servers as NonNullable<Options['mcpServers']>, ...extensions?.mcpServers })
          break
        case 'reload_plugins': {
          const plugins = request.add_plugins === undefined ? undefined
            : parseOfficialAgentSdkLaunchOptions(JSON.stringify({ plugins: request.add_plugins })).plugins
          if (request.hold_on_cache_impact !== undefined && typeof request.hold_on_cache_impact !== 'boolean') throw new Error('Invalid plugin reload option')
          response = await runtime.reloadPlugins({
            ...(plugins ? { addPlugins: plugins } : {}),
            ...(request.hold_on_cache_impact !== undefined ? { holdOnCacheImpact: request.hold_on_cache_impact as boolean } : {}),
          })
          break
        }
        case 'reload_skills':
          response = await runtime.reloadSkills()
          break
        case 'reload_output_styles':
          response = await runtime.reloadOutputStyles()
          break
        case 'rewind_files':
          if (typeof request.user_message_id !== 'string' || !sessionIdPattern.test(request.user_message_id) ||
            (request.dry_run !== undefined && typeof request.dry_run !== 'boolean')) throw new Error('Invalid file rewind request')
          response = await runtime.rewindFiles(request.user_message_id, { dryRun: request.dry_run as boolean | undefined })
          break
        case 'apply_flag_settings': {
          if (!isRecord(request.settings) || Object.keys(request.settings).some(key => !['effortLevel', 'outputStyle', 'alwaysThinkingEnabled', 'fastMode'].includes(key))) {
            throw new Error('Only reasoning and output settings may be changed in a running desktop session')
          }
          await runtime.applyFlagSettings(request.settings)
          if (typeof request.settings.effortLevel === 'string' && efforts.has(request.settings.effortLevel)) {
            ultracode.onEffortChanged(options.effort, request.settings.effortLevel)
            options.effort = request.settings.effortLevel as Options['effort']
          }
          break
        }
        case 'get_session_usage':
          response = await usage.snapshot(runtime, extensions?.usage?.())
          break
        case 'get_context_usage':
          if (request.detail !== undefined && request.detail !== 'summary' && request.detail !== 'full') throw new Error('Invalid context usage detail')
          response = await runtime.getContextUsage({ detail: request.estimateOnly === true ? 'summary' : request.detail as 'summary' | 'full' | undefined })
          break
        case 'background_tasks':
          if (request.tool_use_id !== undefined && typeof request.tool_use_id !== 'string') throw new Error('Invalid background task identifier')
          {
            const id = request.tool_use_id as string | undefined
            const [native, extension] = await Promise.all([runtime.backgroundTasks(id), extensions?.backgroundTasks?.(id)])
            response = { backgrounded: native || extension === true }
          }
          break
        case 'stop_task':
          if (typeof request.task_id !== 'string' || !request.task_id.trim()) throw new Error('Invalid task identifier')
          if (!await extensions?.stopTask?.(request.task_id)) await runtime.stopTask(request.task_id)
          break
        default:
          throw new Error(`Unsupported official Agent SDK control: ${String(request.subtype)}`)
      }
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    } catch (error) {
      send({
        type: 'control_response',
        response: { subtype: 'error', request_id: message.request_id, error: error instanceof Error ? error.message : 'Official Agent SDK control failed' },
      })
    }
  }

  async function receive(payload: string): Promise<void> {
    if (closed) throw new Error('The official Agent SDK session has closed')
    for (const line of payload.split('\n').filter(line => line.trim())) {
      const message: unknown = JSON.parse(line)
      if (!isRecord(message)) throw new Error('Malformed official Agent SDK message')
      if (message.type === 'control_response') respondToPermission(message)
      else if (message.type === 'control_request') await control(message)
      else if (message.type === 'keep_alive') continue
      else if (message.type === 'user') {
        if (ending) throw new Error('The official Agent SDK session is ending')
        if (!isRecord(message.message) || message.message.role !== 'user' ||
          (typeof message.message.content !== 'string' && !Array.isArray(message.message.content))) {
          throw new Error('Malformed official Agent SDK user message')
        }
        const isHumanInput = config.transport === 'websocket' && message.cc_haha_human_input === true &&
          message.isMeta !== true && message.isSynthetic !== true && message.origin === undefined
        const inputContext = { isHumanInput, ...(isHumanInput ? { humanText: typeof message.cc_haha_human_text === 'string' ? message.cc_haha_human_text
          : typeof message.message.content === 'string' ? message.message.content
          : message.message.content.filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') } : {}) }
        const userUuid = typeof message.uuid === 'string' && sessionIdPattern.test(message.uuid) ? message.uuid : crypto.randomUUID()
        if (isHumanInput) {
          const human = { text: inputContext.humanText ?? '', uuid: userUuid }
          humanPrompts.set(userUuid, human)
          if (!latestHuman) latestHuman = human
          if (humanPrompts.size > 64) humanPrompts.delete(humanPrompts.keys().next().value!)
        }
        const modeCommand = isHumanInput && /^\/effort\s+ultracode(?:\s+(on|off))?\s*$/i.exec(inputContext.humanText ?? '')
        if (modeCommand) {
          const state = await ultracode.setEnabled(modeCommand[1]?.toLowerCase() !== 'off')
          send({ type: 'system', subtype: 'official_sdk_ultracode', state, uuid: crypto.randomUUID(), session_id: config.sessionId })
          send({ type: 'system', subtype: 'local_command_output',
            content: state.enabled ? 'Ultracode is on for this running conversation. Model and reasoning effort are unchanged.'
              : 'Ultracode is off for this running conversation.',
            uuid: crypto.randomUUID(), session_id: config.sessionId })
          send({ type: 'result', subtype: 'success', is_error: false, result: '', duration_ms: 0, duration_api_ms: 0,
            num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, session_id: config.sessionId, uuid: crypto.randomUUID() })
          continue
        }
        await extensions?.beforeUserMessage?.(inputContext)
        if (isHumanInput) await ultracode.refreshState()
        let content = message.message.content
        {
          const transform = async (text: string) => ultracode.transformPrompt(
            extensions?.transformPrompt ? await extensions.transformPrompt(text, inputContext) : text, inputContext)
          if (typeof content === 'string') content = await transform(content)
          else {
            const index = content.findIndex(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
            if (index >= 0) {
              const block = content[index] as { type: string; text: string }
              content = [...content]
              content[index] = { ...block, text: await transform(block.text) }
            }
          }
        }
        context.push({ role: 'user', content })
        contextIds.push(userUuid)
        input.push({
          type: 'user',
          message: {
            role: 'user',
            content: content as SDKUserMessage['message']['content'],
          },
          parent_tool_use_id: null,
          session_id: config.sessionId,
          uuid: userUuid as SDKUserMessage['uuid'],
        })
      } else {
        throw new Error(`Unsupported official Agent SDK message: ${String(message.type)}`)
      }
    }
  }

  const done = (async () => {
    try {
      for await (const message of runtime) {
        if (closed) break
        const wire = message as unknown as WireMessage
        if (wire.type === 'system' && wire.subtype === 'elicitation_complete' &&
          typeof wire.mcp_server_name === 'string' && typeof wire.elicitation_id === 'string') {
          for (const [requestId, pending] of permissions) {
            const dialog = pending.input
            if (pending.toolName !== OFFICIAL_SDK_DIALOG_TOOL || dialog.sdkDialog !== true ||
              dialog.serverName !== wire.mcp_server_name || dialog.elicitationId !== wire.elicitation_id) continue
            const response = dialog.nativeKind === 'mcp_elicitation_waiting' ? { choice: 'dismiss' }
              : dialog.kind === 'elicitation' && dialog.mode === 'url' && typeof dialog.url === 'string'
                ? { action: 'accept', openedUrl: dialog.url } : undefined
            if (!response) continue
            // The MCP server confirms completion, not permission to perform a
            // new action. Retire only its exact waiting URL prompt.
            send({ type: 'control_cancel_request', request_id: requestId })
            pending.settle({ behavior: 'allow', updatedInput: { sdkDialogResult: response } })
          }
        }
        if (typeof wire.user_message_uuid === 'string' && !wire.parent_tool_use_id) latestHuman = humanPrompts.get(wire.user_message_uuid)
        const nativeMessageIds = identity.observe(wire)
        retract(wire.supersedes)
        if (message.type === 'system' && message.subtype === 'model_refusal_fallback') {
          retract(message.retracted_message_uuids)
          if (message.scope !== 'local') {
            currentModel = message.fallback_model
            options.model = currentModel
          }
        }
        if (wire.type === 'system' && wire.subtype === 'model_consent_fallback' && typeof wire.fallback_model === 'string') {
          currentModel = wire.fallback_model
          options.model = currentModel
        }
        usage.observe(message)
        const extra = message.type === 'result' ? extensions?.usage?.() : undefined
        const projected = message.type === 'assistant' ? {
          ...message, message: { ...message.message, content: normalizeOfficialAgentSdkToolContent(message.message.content) },
        } : message.type === 'stream_event' && message.event.type === 'content_block_start' ? {
          ...message, event: { ...message.event, content_block: normalizeOfficialAgentSdkToolContent([message.event.content_block])[0] },
        } : message
        send(message.type === 'result' && extra ? {
          ...message,
          total_cost_usd: message.total_cost_usd + extra.totalCostUSD,
          modelUsage: mergeOfficialAgentSdkModelUsage(message.modelUsage ?? {}, extra.modelUsage),
        } : { ...projected, ...(nativeMessageIds ? { cc_haha_message_ids: nativeMessageIds } : {}) } as unknown as WireMessage)
        if (message.type === 'assistant' || message.type === 'user') {
          if ('uuid' in message && typeof message.uuid === 'string') resumeAt = message.uuid
          context.push(message.message)
          contextIds.push(typeof message.uuid === 'string' ? message.uuid : undefined)
        }
        if (message.type === 'result') {
          latestHuman = undefined
          await extensions?.onTurnEnd?.()
          input.finishTurn()
        }
      }
    } catch (error) {
      if (!closed) throw error
    } finally {
      close()
      try { await extensionClose } finally { settingsFile.close() }
    }
  })()
  // The entrypoint awaits this promise; attach now so immediate SDK failures
  // cannot become unhandled rejections before its socket callback attaches.
  void done.catch(() => undefined)
  return { receive, close, ready, done }
}
