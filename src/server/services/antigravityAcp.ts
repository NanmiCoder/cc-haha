import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { buildNetworkEnvironment, loadNetworkSettings } from './networkSettings.js'

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity-acp'
export const ANTIGRAVITY_DEFAULT_MODEL = 'agent-default'
export const ANTIGRAVITY_CLIENT_INFO = { name: 'cc-haha', version: '0.8.0' } as const

const REQUEST_TIMEOUT = 15_000
const DISCOVERY_EXIT_TIMEOUT_MS = 2_000
const DISCOVERY_KILL_GRACE_MS = 1_000
const MAX_FRAME_CHARS = 16 * 1024 * 1024
const LOGIN_MESSAGE = 'Antigravity CLI is not signed in. Run `agy acp --login` in a terminal on the server machine, then retry.'
const BYPASS_CAPABILITY_UNAVAILABLE =
  'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions'
export const ANTIGRAVITY_BYPASS_EXIT_REQUIRES_RESTART =
  'Cannot leave bypassPermissions in-process because the Antigravity session was launched with --dangerously-skip-permissions'

type RpcObject = Record<string, unknown>
type RpcId = string | number

export type AntigravityErrorCode =
  | 'ANTIGRAVITY_NOT_INSTALLED'
  | 'ANTIGRAVITY_LOGIN_REQUIRED'
  | 'ANTIGRAVITY_CONNECTION_FAILED'
  | 'ANTIGRAVITY_MODEL_UNAVAILABLE'
  | 'ANTIGRAVITY_UNSUPPORTED'
  | 'ANTIGRAVITY_RESUME_FAILED'
  | 'ANTIGRAVITY_TURN_FAILED'

export class AntigravityError extends Error {
  constructor(readonly code: AntigravityErrorCode, message: string) {
    super(message)
  }
}

export type AntigravityModelInfo = {
  id: string
  name: string
  supportedReasoningEfforts?: string[]
  defaultReasoningEffort?: string
}

export type AntigravityTierInfo = {
  id?: string
  name?: string
}

export type AntigravityStatus = {
  id: typeof ANTIGRAVITY_PROVIDER_ID
  kind: 'acp'
  status: 'not_installed' | 'unchecked' | 'ready' | 'login_required' | 'error'
  models: AntigravityModelInfo[]
  currentModelId?: string
  currentEffortLevel?: string
  version?: string
  tier?: AntigravityTierInfo
}

export type AntigravitySlashCommand = {
  name: string
  description: string
  argumentHint?: string
}

export type AntigravityMcpServerConfig =
  | {
      type: 'http'
      name: string
      url: string
      headers?: Array<{ name: string; value: string }>
    }
  | {
      name: string
      command: string
      args?: string[]
      env?: Array<{ name: string; value: string }>
    }

export type AntigravityAcpMode = 'default' | 'accept-edits' | 'auto' | 'plan'
export type AntigravityCcHahaPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'

export type OpenAntigravityAcpOptions = {
  nativeSessionId?: string
  modelId?: string
  effortLevel?: string
  permissionMode?: string
  additionalDirectories?: string[]
  mcpServers?: AntigravityMcpServerConfig[]
  systemPromptAppend?: string
}

export function ccHahaPermissionModeToAcpMode(mode: string | undefined): AntigravityAcpMode | undefined {
  switch (mode) {
    case 'default':
      return 'default'
    case 'acceptEdits':
      return 'accept-edits'
    case 'auto':
      return 'auto'
    case 'plan':
      return 'plan'
    default:
      return undefined
  }
}

export function acpModeToCcHahaPermissionMode(mode: string | undefined): 'default' | 'acceptEdits' | 'auto' | 'plan' | undefined {
  switch (mode) {
    case 'default':
      return 'default'
    case 'accept-edits':
      return 'acceptEdits'
    case 'auto':
      return 'auto'
    case 'plan':
      return 'plan'
    default:
      return undefined
  }
}

export function isAntigravitySupportedPermissionMode(mode: string | undefined): mode is AntigravityCcHahaPermissionMode {
  return mode === 'default' || mode === 'acceptEdits' || mode === 'auto' || mode === 'plan' || mode === 'bypassPermissions'
}

export function acpObject(value: unknown): RpcObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RpcObject : undefined
}

function executable(env: NodeJS.ProcessEnv = process.env): string | null {
  // 桌面端启动时 PATH 可能不含官方安装器的 ~/.local/bin。
  // 忽略相对路径，避免工作目录中的文件冒充 AGY。
  const dirs = (env.PATH ?? '').split(delimiter).filter(isAbsolute)
  dirs.push(join(homedir(), '.local', 'bin'))
  return Bun.which('agy', { PATH: dirs.join(delimiter) })
}

export function antigravityEnvironment(cwd: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // 保留系统身份和 CLI 配置位置，不向外部 Agent 传入本应用的密钥或运行时配置。
  const allowed = /^(HOME|USER|LOGNAME|SHELL|PATH|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_\w+|TERM|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_(CONFIG|DATA|STATE|CACHE|RUNTIME)_HOME|XDG_RUNTIME_DIR|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_(FILE|DIR)|GEMINI_HOME|SSH_CONNECTION)$/i
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.test(key) && typeof value === 'string')) as Record<string, string>,
    PWD: cwd,
  }
}

type PendingRpc = {
  resolve(value: RpcObject): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

function connectionError(message = 'Lost the connection to Antigravity CLI. Check that `agy acp` runs on the server machine, then retry.'): AntigravityError {
  return new AntigravityError('ANTIGRAVITY_CONNECTION_FAILED', message)
}

function rpcError(value: unknown): AntigravityError {
  const error = acpObject(value)
  const text = typeof error?.message === 'string' ? error.message : ''
  if (error?.code === -32000 || (error?.code === -32603 && text.startsWith('No browser is available here'))) {
    return new AntigravityError('ANTIGRAVITY_LOGIN_REQUIRED', LOGIN_MESSAGE)
  }
  // AGY errors can contain account URLs or command output. Do not expose raw RPC errors.
  return connectionError(typeof error?.code === 'number' ? `Antigravity CLI rejected an ACP request (RPC ${error.code}).` : undefined)
}

class AntigravityRpc {
  readonly proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>
  readonly drained: Promise<void>
  private nextId = 0
  private pending = new Map<number, PendingRpc>()
  private failed?: Error
  onMessage?: (method: string, params: RpcObject, id?: RpcId) => void

  constructor(private readonly binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    try {
      this.proc = Bun.spawn([binary, ...args], {
        cwd,
        env: antigravityEnvironment(cwd, env),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
        windowsHide: true,
      })
    } catch {
      throw connectionError('Could not launch Antigravity CLI. Check that `agy acp` runs on the server machine.')
    }
    this.drained = this.read()
  }

  private async read(): Promise<void> {
    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          if (newline > MAX_FRAME_CHARS) throw connectionError('Antigravity sent an oversized ACP frame.')
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) this.receive(line)
          if (this.failed) return
        }
        if (buffer.length > MAX_FRAME_CHARS) throw connectionError('Antigravity sent an oversized ACP frame.')
      }
      const lastLine = (buffer + decoder.decode()).trim()
      if (lastLine) this.receive(lastLine)
      this.fail(connectionError())
    } catch (error) {
      this.fail(error instanceof AntigravityError ? error : connectionError())
      this.proc.kill()
    } finally {
      reader.releaseLock()
    }
  }

  private receive(line: string): void {
    if (line.startsWith('Open the following link to authenticate the ACP server:')) {
      this.requireLogin(new AntigravityError('ANTIGRAVITY_LOGIN_REQUIRED', LOGIN_MESSAGE))
      this.proc.kill()
      return
    }
    let frame: RpcObject | undefined
    try { frame = acpObject(JSON.parse(line)) } catch { return }
    if (frame?.jsonrpc !== '2.0') return
    const id = typeof frame.id === 'number' || typeof frame.id === 'string' ? frame.id : undefined
    if (typeof frame.method === 'string') {
      const params = acpObject(frame.params)
      if (this.onMessage && params) this.onMessage(frame.method, params, id)
      else if (id !== undefined) this.reply(id, undefined, -32601)
    } else if (typeof id === 'number') {
      const waiter = this.pending.get(id)
      if (!waiter) return
      this.pending.delete(id)
      clearTimeout(waiter.timer)
      if ('error' in frame) {
        const error = rpcError(frame.error)
        if (error.code === 'ANTIGRAVITY_LOGIN_REQUIRED') this.requireLogin(error)
        waiter.reject(error)
      } else {
        waiter.resolve(acpObject(frame.result) ?? {})
      }
    }
  }

  private requireLogin(error: AntigravityError): void {
    lastStatus = { binary: this.binary, report: report('login_required') }
    this.fail(error)
  }

  private fail(error: Error): void {
    this.failed ??= error
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(this.failed)
    }
    this.pending.clear()
  }

  private send(frame: RpcObject): boolean {
    if (this.failed || this.proc.exitCode !== null) return false
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
      void Promise.resolve(this.proc.stdin.flush()).catch(() => this.fail(connectionError()))
      return true
    } catch {
      this.fail(connectionError())
      return false
    }
  }

  request(method: string, params: RpcObject, timeout = REQUEST_TIMEOUT): Promise<RpcObject> {
    if (this.failed) return Promise.reject(this.failed)
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(id)
        reject(connectionError(`Antigravity did not respond to ${method}.`))
      }, timeout) : undefined
      this.pending.set(id, { resolve, reject, timer })
      if (!this.send({ id, method, params })) this.fail(connectionError())
    })
  }

  notify(method: string, params: RpcObject): boolean {
    return this.send({ method, params })
  }

  reply(id: RpcId, result?: RpcObject, errorCode?: number): boolean {
    return this.send({
      id,
      ...(errorCode
        ? { error: { code: errorCode, message: errorCode === -32602 ? 'Invalid ACP params' : 'Unsupported ACP request' } }
        : { result }),
    })
  }

  get isOpen(): boolean { return !this.failed && this.proc.exitCode === null }

  end(): void { this.fail(connectionError()) }

  close(signal?: NodeJS.Signals): void {
    this.end()
    if (this.proc.exitCode === null) this.proc.kill(signal)
  }
}

export function configOption(result: RpcObject, category: string): RpcObject | undefined {
  return Array.isArray(result.configOptions)
    ? result.configOptions.map(acpObject).find(option => option?.type === 'select' && (option.category === category || option.id === category))
    : undefined
}

function selectOptionEntries(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) => {
    const option = acpObject(entry)
    if (typeof option?.value === 'string' && typeof option.name === 'string') return [{ id: option.value, name: option.name }]
    return Array.isArray(option?.options) ? option.options.flatMap((item: unknown) => {
      const child = acpObject(item)
      return typeof child?.value === 'string' && typeof child.name === 'string' ? [{ id: child.value, name: child.name }] : []
    }) : []
  })
}

export function parseAvailableCommands(value: unknown): AntigravitySlashCommand[] {
  if (!Array.isArray(value)) return []
  const commands: AntigravitySlashCommand[] = []
  for (const item of value) {
    const entry = acpObject(item)
    const rawName = typeof entry?.name === 'string' ? entry.name.trim() : ''
    if (!rawName) continue
    const name = rawName.startsWith('/') ? rawName.slice(1) : rawName
    if (!name) continue
    const description = typeof entry?.description === 'string' ? entry.description : ''
    const inputObj = acpObject(entry?.input)
    const argumentHint = typeof inputObj?.hint === 'string' && inputObj.hint.trim()
      ? inputObj.hint.trim()
      : typeof entry?.argumentHint === 'string' && entry.argumentHint.trim()
        ? entry.argumentHint.trim()
        : undefined
    commands.push({ name, description, ...(argumentHint ? { argumentHint } : {}) })
  }
  return commands
}

function parseTier(result: RpcObject): AntigravityTierInfo | undefined {
  const direct = acpObject(result.tier)
  const metaTier = acpObject(acpObject(acpObject(result._meta)?.antigravity)?.tier)
  const raw = direct ?? metaTier
  if (!raw) return undefined
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined
  if (!id && !name) return undefined
  return { ...(id ? { id } : {}), ...(name ? { name } : {}) }
}

let lastStatus: { binary: string; report: AntigravityStatus } | undefined
let lastDiscoveredCommands: { binary: string; commands: AntigravitySlashCommand[] } | undefined
let pendingDiscovery: Promise<AntigravityStatus> | undefined

function report(status: AntigravityStatus['status'], extra?: Partial<AntigravityStatus>): AntigravityStatus {
  return { id: ANTIGRAVITY_PROVIDER_ID, kind: 'acp', status, models: [], ...extra }
}

export function getAntigravityStatus(): AntigravityStatus {
  const binary = executable()
  if (!binary) return report('not_installed')
  return lastStatus?.binary === binary ? lastStatus.report : report('unchecked')
}

export function getAntigravityDiscoveredCommands(): AntigravitySlashCommand[] {
  const binary = executable()
  if (!binary || lastDiscoveredCommands?.binary !== binary) return []
  return lastDiscoveredCommands.commands
}

export function resetAntigravityStatusForTests(): void {
  lastStatus = undefined
  lastDiscoveredCommands = undefined
  pendingDiscovery = undefined
}

type AntigravityAcpInitState = {
  sessionId: string
  modelId: string | undefined
  effortLevel: string | undefined
  permissionMode: AntigravityCcHahaPermissionMode
  launchedWithBypassPermissions: boolean
  supportsImages: boolean
  version?: string
  tier?: AntigravityTierInfo
  modelConfigId?: string
  effortConfigId?: string
  modeConfigId?: string
  availableModels: AntigravityModelInfo[]
  availableEfforts: string[]
  availableModes: string[]
  initialAvailableCommands: AntigravitySlashCommand[]
}

export class AntigravityAcp {
  modelId: string | undefined
  effortLevel: string | undefined
  permissionMode: AntigravityCcHahaPermissionMode
  readonly sessionId: string
  readonly launchedWithBypassPermissions: boolean
  readonly supportsImages: boolean
  readonly version?: string
  readonly tier?: AntigravityTierInfo
  initialAvailableCommands: AntigravitySlashCommand[]
  private modelConfigId?: string
  private effortConfigId?: string
  private modeConfigId?: string
  private availableModels: AntigravityModelInfo[]
  private availableEfforts: string[]
  private availableModes: string[]

  constructor(
    private readonly rpc: AntigravityRpc,
    state: AntigravityAcpInitState,
  ) {
    this.sessionId = state.sessionId
    this.modelId = state.modelId
    this.effortLevel = state.effortLevel
    this.permissionMode = state.permissionMode
    this.launchedWithBypassPermissions = state.launchedWithBypassPermissions
    this.supportsImages = state.supportsImages
    this.version = state.version
    this.tier = state.tier
    this.modelConfigId = state.modelConfigId
    this.effortConfigId = state.effortConfigId
    this.modeConfigId = state.modeConfigId
    this.availableModels = state.availableModels
    this.availableEfforts = state.availableEfforts
    this.availableModes = state.availableModes
    this.initialAvailableCommands = state.initialAvailableCommands
  }

  get proc() { return this.rpc.proc }
  get drained() { return this.rpc.drained }
  get isOpen() { return this.rpc.isOpen }
  set onMessage(handler: AntigravityRpc['onMessage']) { this.rpc.onMessage = handler }
  prompt(prompt: unknown[]) { return this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt }, 0) }
  cancel() { return this.rpc.notify('session/cancel', { sessionId: this.sessionId }) }
  reply(id: RpcId, result?: RpcObject, errorCode?: number) { return this.rpc.reply(id, result, errorCode) }
  end() { this.rpc.end() }
  close(signal?: NodeJS.Signals) { this.rpc.close(signal) }

  private syncConfigOptionsFromResponse(response: RpcObject): void {
    const hasConfigOptions = Array.isArray(response.configOptions)
    const model = configOption(response, 'model')
    if (typeof model?.id === 'string') this.modelConfigId = model.id
    if (typeof model?.currentValue === 'string') this.modelId = model.currentValue
    const effort = configOption(response, 'thought_level')
    if (effort) {
      this.effortConfigId = typeof effort.id === 'string' ? effort.id : undefined
      this.effortLevel = typeof effort.currentValue === 'string' ? effort.currentValue : undefined
      this.availableEfforts = selectOptionEntries(effort.options).map(o => o.id)
    } else if (hasConfigOptions) {
      this.effortConfigId = undefined
      this.effortLevel = undefined
      this.availableEfforts = []
    }
    const prevById = new Map(this.availableModels.map(entry => [entry.id, entry]))
    const modelChoices = selectOptionEntries(model?.options)
    if (modelChoices.length > 0) {
      this.availableModels = modelChoices.map(entry => {
        if (entry.id === this.modelId) {
          return {
            ...entry,
            supportedReasoningEfforts: [...this.availableEfforts],
            ...(this.effortLevel ? { defaultReasoningEffort: this.effortLevel } : {}),
          }
        }
        const prev = prevById.get(entry.id)
        return {
          ...entry,
          ...(prev?.supportedReasoningEfforts !== undefined
            ? { supportedReasoningEfforts: [...prev.supportedReasoningEfforts] }
            : {}),
          ...(prev?.defaultReasoningEffort ? { defaultReasoningEffort: prev.defaultReasoningEffort } : {}),
        }
      })
    }
    const mode = configOption(response, 'mode')
    if (typeof mode?.id === 'string') this.modeConfigId = mode.id
    const modeChoices = selectOptionEntries(mode?.options).map(o => o.id)
    if (modeChoices.length > 0) this.availableModes = modeChoices
    if (!this.launchedWithBypassPermissions && typeof mode?.currentValue === 'string') {
      const mapped = acpModeToCcHahaPermissionMode(mode.currentValue)
      if (mapped) this.permissionMode = mapped
    }
  }

  /**
   * Probes each advertised model's `thought_level` options via local in-memory
   * `session/set_config_option` calls (only used during short-lived discovery).
   */
  async probeAllModelEfforts(): Promise<AntigravityModelInfo[]> {
    if (!this.modelConfigId || this.availableModels.length <= 1) {
      return this.availableModels
    }
    const probed: AntigravityModelInfo[] = []
    const initialModelId = this.modelId
    for (const entry of this.availableModels) {
      if (entry.id === initialModelId) {
        probed.push({
          id: entry.id,
          name: entry.name,
          supportedReasoningEfforts: [...this.availableEfforts],
          ...(this.effortLevel ? { defaultReasoningEffort: this.effortLevel } : {}),
        })
        continue
      }
      try {
        const selection = await this.rpc.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: this.modelConfigId,
          value: entry.id,
        })
        const effortOpt = configOption(selection, 'thought_level')
        const efforts = selectOptionEntries(effortOpt?.options).map(o => o.id)
        const defaultEffort = typeof effortOpt?.currentValue === 'string' ? effortOpt.currentValue : undefined
        probed.push({
          id: entry.id,
          name: entry.name,
          supportedReasoningEfforts: efforts,
          ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
        })
      } catch {
        probed.push(entry)
      }
    }
    this.availableModels = probed
    return probed
  }

  async setModel(modelId: string): Promise<void> {
    if (modelId === ANTIGRAVITY_DEFAULT_MODEL || modelId === this.modelId) return
    if (!this.modelConfigId || (this.availableModels.length > 0 && !this.availableModels.some(option => option.id === modelId))) {
      throw new AntigravityError('ANTIGRAVITY_MODEL_UNAVAILABLE', 'The selected model is not available to Antigravity. Refresh its models or choose the CLI default.')
    }
    const selection = await this.rpc.request('session/set_config_option', {
      sessionId: this.sessionId,
      configId: this.modelConfigId,
      value: modelId,
    })
    if (configOption(selection, 'model')?.currentValue !== modelId) {
      throw new AntigravityError('ANTIGRAVITY_MODEL_UNAVAILABLE', 'Antigravity did not confirm the selected model. Refresh its models and try again.')
    }
    this.syncConfigOptionsFromResponse(selection)
  }

  async setEffortLevel(effortLevel: string): Promise<void> {
    if (!effortLevel || effortLevel === this.effortLevel) return
    if (!this.effortConfigId) {
      throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', 'This Antigravity CLI does not expose thought_level configuration.')
    }
    if (this.availableEfforts.length > 0 && !this.availableEfforts.includes(effortLevel)) {
      throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', `Reasoning effort "${effortLevel}" is not available for the selected Antigravity model.`)
    }
    const selection = await this.rpc.request('session/set_config_option', {
      sessionId: this.sessionId,
      configId: this.effortConfigId,
      value: effortLevel,
    })
    const confirmed = configOption(selection, 'thought_level')?.currentValue
    if (confirmed !== effortLevel) {
      throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', 'Antigravity did not confirm the selected thinking level.')
    }
    this.syncConfigOptionsFromResponse(selection)
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (mode === 'bypassPermissions') {
      if (this.launchedWithBypassPermissions) {
        this.permissionMode = 'bypassPermissions'
        return
      }
      throw new Error(BYPASS_CAPABILITY_UNAVAILABLE)
    }
    const acpMode = ccHahaPermissionModeToAcpMode(mode)
    if (!acpMode) {
      throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', `Permission mode "${mode}" is not supported by Antigravity.`)
    }
    if (this.launchedWithBypassPermissions) {
      throw new Error(ANTIGRAVITY_BYPASS_EXIT_REQUIRES_RESTART)
    }
    if (!this.modeConfigId) {
      if (acpMode === 'default') {
        this.permissionMode = 'default'
        return
      }
      throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', 'This Antigravity CLI does not support changing permission modes.')
    }
    if (this.availableModes.length > 0 && !this.availableModes.includes(acpMode)) {
      throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', `Permission mode "${mode}" is not supported by this Antigravity CLI.`)
    }
    const selection = await this.rpc.request('session/set_config_option', {
      sessionId: this.sessionId,
      configId: this.modeConfigId,
      value: acpMode,
    })
    const confirmed = configOption(selection, 'mode')?.currentValue
    if (confirmed !== acpMode) {
      throw connectionError(`Antigravity did not confirm permission mode "${mode}".`)
    }
    this.syncConfigOptionsFromResponse(selection)
    this.permissionMode = mode as AntigravityCcHahaPermissionMode
  }
}

export async function openAntigravityAcp(
  cwd: string,
  options: OpenAntigravityAcpOptions = {},
): Promise<AntigravityAcp> {
  const {
    nativeSessionId,
    modelId = ANTIGRAVITY_DEFAULT_MODEL,
    effortLevel,
    permissionMode = 'default',
    additionalDirectories = [],
    mcpServers = [],
    systemPromptAppend,
  } = options

  const binary = executable()
  if (!binary) {
    throw new AntigravityError('ANTIGRAVITY_NOT_INSTALLED', 'Install Antigravity CLI so `agy` is available on the server machine.')
  }
  if (!isAntigravitySupportedPermissionMode(permissionMode)) {
    throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', `Permission mode "${permissionMode}" is not supported by Antigravity.`)
  }
  let networkEnv: Record<string, string>
  try {
    // 复用系统或手动网络代理；这不改变 AGY 的官方 API 端点或认证。
    networkEnv = buildNetworkEnvironment(await loadNetworkSettings())
  } catch {
    throw connectionError('Check the network proxy in Settings before connecting to Antigravity CLI.')
  }

  const launchedWithBypassPermissions = permissionMode === 'bypassPermissions'
  const spawnArgs = [
    'acp',
    '--process-per-session',
    ...(launchedWithBypassPermissions ? ['--dangerously-skip-permissions'] : []),
  ]
  const rpc = new AntigravityRpc(binary, spawnArgs, cwd, { ...process.env, ...networkEnv })
  let initialAvailableCommands: AntigravitySlashCommand[] = []
  let acp: AntigravityAcp | undefined
  rpc.onMessage = (method, params, id) => {
    if (id !== undefined) {
      rpc.reply(id, undefined, -32601)
      return
    }
    if (method !== 'session/update') return
    const update = acpObject(params.update)
    if (update?.sessionUpdate === 'available_commands_update') {
      const commands = parseAvailableCommands(update.availableCommands)
      initialAvailableCommands = commands
      if (acp) {
        acp.initialAvailableCommands = commands
      }
    }
  }

  try {
    const init = await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: ANTIGRAVITY_CLIENT_INFO,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
      },
    })
    if (init.protocolVersion !== 1) {
      throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', 'This version of Antigravity CLI did not negotiate ACP version 1. Update the CLI and retry.')
    }
    const capabilities = acpObject(init.agentCapabilities)
    const version = acpObject(init.agentInfo)?.version
    const sessionCaps = acpObject(capabilities?.sessionCapabilities ?? capabilities?.session_capabilities)
    const mcpCaps = acpObject(capabilities?.mcpCapabilities ?? capabilities?.mcp_capabilities)
    const agyMetaCaps = acpObject(acpObject(capabilities?._meta)?.antigravity)
    const supportsHttpMcp = mcpCaps?.http === true
    const supportsSystemPromptAppend = acpObject(agyMetaCaps?.systemPrompt)?.append === true
    const filteredMcpServers = mcpServers.filter(server => !('type' in server && server.type === 'http') || supportsHttpMcp)
    const extraDirs = additionalDirectories.filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0)
    const metaPayload = systemPromptAppend && supportsSystemPromptAppend
      ? { antigravity: { systemPrompt: { append: systemPromptAppend } } }
      : undefined

    let result: RpcObject
    if (nativeSessionId) {
      if (!sessionCaps?.resume) {
        throw new AntigravityError('ANTIGRAVITY_RESUME_FAILED', 'This CLI cannot resume the saved Antigravity session. Start a new chat or update Antigravity CLI.')
      }
      try {
        result = await rpc.request('session/resume', {
          sessionId: nativeSessionId,
          cwd,
          mcpServers: filteredMcpServers,
          ...(extraDirs.length > 0 ? { additionalDirectories: extraDirs } : {}),
          ...(metaPayload ? { _meta: metaPayload } : {}),
        })
      } catch (error) {
        if (error instanceof AntigravityError && error.code === 'ANTIGRAVITY_LOGIN_REQUIRED') throw error
        throw new AntigravityError('ANTIGRAVITY_RESUME_FAILED', 'Antigravity could not resume this saved session. Open a new chat if the original CLI history was removed.')
      }
    } else {
      // authMethods are offered even when signed in; session/new is authoritative.
      result = await rpc.request('session/new', {
        cwd,
        mcpServers: filteredMcpServers,
        ...(extraDirs.length > 0 ? { additionalDirectories: extraDirs } : {}),
        ...(metaPayload ? { _meta: metaPayload } : {}),
      })
    }

    const nativeId = nativeSessionId ?? result.sessionId
    if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 512) {
      throw connectionError('Antigravity did not return a valid ACP session ID.')
    }

    const modelOpt = configOption(result, 'model')
    const effortOpt = configOption(result, 'thought_level')
    const modeOpt = configOption(result, 'mode')

    const rawModels = selectOptionEntries(modelOpt?.options)
    const availableEfforts = selectOptionEntries(effortOpt?.options).map(o => o.id)
    const availableModes = selectOptionEntries(modeOpt?.options).map(o => o.id)
    const currentModelId = typeof modelOpt?.currentValue === 'string' ? modelOpt.currentValue : undefined
    const currentEffortLevel = typeof effortOpt?.currentValue === 'string' ? effortOpt.currentValue : undefined
    const tier = parseTier(result)

    const previous = lastStatus?.binary === binary && lastStatus.report.status === 'ready' ? lastStatus.report : undefined
    const previousById = new Map((previous?.models ?? []).map(entry => [entry.id, entry]))
    const enrichedModels: AntigravityModelInfo[] = rawModels.map(entry => {
      if (entry.id === currentModelId) {
        return {
          id: entry.id,
          name: entry.name,
          supportedReasoningEfforts: [...availableEfforts],
          ...(currentEffortLevel ? { defaultReasoningEffort: currentEffortLevel } : {}),
        }
      }
      const prev = previousById.get(entry.id)
      return {
        id: entry.id,
        name: entry.name,
        ...(prev?.supportedReasoningEfforts !== undefined
          ? { supportedReasoningEfforts: [...prev.supportedReasoningEfforts] }
          : {}),
        ...(prev?.defaultReasoningEffort ? { defaultReasoningEffort: prev.defaultReasoningEffort } : {}),
      }
    })

    lastStatus = {
      binary,
      report: report('ready', {
        models: enrichedModels.length > 0 ? enrichedModels : previous?.models ?? [],
        currentModelId: nativeSessionId ? previous?.currentModelId ?? currentModelId : currentModelId,
        currentEffortLevel: nativeSessionId ? previous?.currentEffortLevel ?? currentEffortLevel : currentEffortLevel,
        ...(typeof version === 'string' ? { version } : previous?.version ? { version: previous.version } : {}),
        ...(tier ? { tier } : previous?.tier ? { tier: previous.tier } : {}),
      }),
    }

    const currentAcpMode = typeof modeOpt?.currentValue === 'string' ? modeOpt.currentValue : undefined
    const initialMode: AntigravityCcHahaPermissionMode = launchedWithBypassPermissions
      ? 'bypassPermissions'
      : acpModeToCcHahaPermissionMode(currentAcpMode) ?? 'default'

    acp = new AntigravityAcp(rpc, {
      sessionId: nativeId,
      modelId: currentModelId,
      effortLevel: currentEffortLevel,
      permissionMode: initialMode,
      launchedWithBypassPermissions,
      supportsImages: acpObject(capabilities?.promptCapabilities)?.image === true,
      ...(typeof version === 'string' ? { version } : {}),
      ...(tier ? { tier } : {}),
      modelConfigId: typeof modelOpt?.id === 'string' ? modelOpt.id : undefined,
      effortConfigId: typeof effortOpt?.id === 'string' ? effortOpt.id : undefined,
      modeConfigId: typeof modeOpt?.id === 'string' ? modeOpt.id : undefined,
      availableModels: enrichedModels,
      availableEfforts,
      availableModes,
      initialAvailableCommands,
    })

    if (modelId !== ANTIGRAVITY_DEFAULT_MODEL && modelId !== acp.modelId) {
      await acp.setModel(modelId)
    }
    if (effortLevel && effortLevel !== acp.effortLevel) {
      if (acp.availableEfforts.length > 0 && acp.availableEfforts.includes(effortLevel)) {
        await acp.setEffortLevel(effortLevel)
      }
    }
    if (!launchedWithBypassPermissions) {
      const targetAcpMode = ccHahaPermissionModeToAcpMode(permissionMode) ?? 'default'
      if (typeof modeOpt?.id === 'string') {
        if (currentAcpMode !== targetAcpMode) {
          await acp.setPermissionMode(permissionMode)
        } else {
          acp.permissionMode = permissionMode as AntigravityCcHahaPermissionMode
        }
      } else if (targetAcpMode !== 'default') {
        throw new AntigravityError(
          'ANTIGRAVITY_UNSUPPORTED',
          'This Antigravity CLI does not support changing permission modes.',
        )
      } else {
        acp.permissionMode = 'default'
      }
    }

    return acp
  } catch (error) {
    rpc.close()
    if (error instanceof AntigravityError && error.code === 'ANTIGRAVITY_LOGIN_REQUIRED') {
      lastStatus = { binary, report: report('login_required') }
    }
    throw error
  }
}

async function waitForSubprocessExit(
  proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>,
  termTimeoutMs = DISCOVERY_EXIT_TIMEOUT_MS,
  killGraceMs = DISCOVERY_KILL_GRACE_MS,
): Promise<void> {
  if (proc.exitCode !== null) return
  let termTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const exitedBeforeTerm = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>(resolve => {
        termTimer = setTimeout(() => resolve(false), termTimeoutMs)
      }),
    ])
    if (exitedBeforeTerm) return
    if (proc.exitCode === null) {
      try { proc.kill('SIGKILL') } catch { /* process already exited */ }
    }
    await Promise.race([
      proc.exited.then(() => undefined),
      new Promise<void>(resolve => {
        killTimer = setTimeout(resolve, killGraceMs)
      }),
    ])
  } finally {
    if (termTimer) clearTimeout(termTimer)
    if (killTimer) clearTimeout(killTimer)
  }
}

export function discoverAntigravity(options?: { exitTimeoutMs?: number }): Promise<AntigravityStatus> {
  if (pendingDiscovery) return pendingDiscovery
  pendingDiscovery = (async () => {
    const binary = executable()
    if (!binary) return report('not_installed')
    const cwd = await mkdtemp(join(tmpdir(), 'cchaha-agy-'))
    try {
      const acp = await openAntigravityAcp(cwd)
      const initialModelId = acp.modelId
      const initialEffortLevel = acp.effortLevel
      const probedModels = await acp.probeAllModelEfforts()
      if (acp.initialAvailableCommands.length > 0) {
        lastDiscoveredCommands = { binary, commands: acp.initialAvailableCommands }
      }
      if (probedModels.length > 0 && lastStatus?.binary === binary && lastStatus.report.status === 'ready') {
        lastStatus = {
          binary,
          report: {
            ...lastStatus.report,
            models: probedModels,
            ...(initialModelId ? { currentModelId: initialModelId } : {}),
            ...(initialEffortLevel ? { currentEffortLevel: initialEffortLevel } : {}),
          },
        }
      }
      acp.close()
      await waitForSubprocessExit(acp.proc, options?.exitTimeoutMs ?? DISCOVERY_EXIT_TIMEOUT_MS)
      return getAntigravityStatus()
    } catch (error) {
      const status = error instanceof AntigravityError && error.code === 'ANTIGRAVITY_LOGIN_REQUIRED' ? 'login_required' : 'error'
      const failed = report(status)
      lastStatus = { binary, report: failed }
      return failed
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })().finally(() => { pendingDiscovery = undefined })
  return pendingDiscovery
}
