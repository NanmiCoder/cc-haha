import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { buildNetworkEnvironment, loadNetworkSettings } from './networkSettings.js'

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity-acp'
export const ANTIGRAVITY_DEFAULT_MODEL = 'agent-default'
const REQUEST_TIMEOUT = 15_000
const MAX_FRAME_CHARS = 16 * 1024 * 1024
const LOGIN_MESSAGE = 'Antigravity CLI is not signed in. Run `agy acp --login` in a terminal on the server machine, then retry.'

type RpcObject = Record<string, unknown>
type RpcId = string | number
export type AntigravityErrorCode = 'ANTIGRAVITY_NOT_INSTALLED' | 'ANTIGRAVITY_LOGIN_REQUIRED' | 'ANTIGRAVITY_CONNECTION_FAILED' | 'ANTIGRAVITY_MODEL_UNAVAILABLE' | 'ANTIGRAVITY_UNSUPPORTED' | 'ANTIGRAVITY_RESUME_FAILED' | 'ANTIGRAVITY_TURN_FAILED'

export class AntigravityError extends Error {
  constructor(readonly code: AntigravityErrorCode, message: string) {
    super(message)
  }
}

export type AntigravityStatus = {
  id: typeof ANTIGRAVITY_PROVIDER_ID
  kind: 'acp'
  status: 'not_installed' | 'unchecked' | 'ready' | 'login_required' | 'error'
  models: { id: string; name: string }[]
  currentModelId?: string
  version?: string
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

  constructor(private readonly binary: string, cwd: string, env: NodeJS.ProcessEnv) {
    try {
      this.proc = Bun.spawn([binary, 'acp'], {
        cwd, env: antigravityEnvironment(cwd, env), stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', windowsHide: true,
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
      } else waiter.resolve(acpObject(frame.result) ?? {})
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
    return this.send({ id, ...(errorCode ? { error: { code: errorCode, message: 'Unsupported ACP request' } } : { result }) })
  }

  get isOpen(): boolean { return !this.failed && this.proc.exitCode === null }

  end(): void { this.fail(connectionError()) }

  close(signal?: NodeJS.Signals): void {
    this.end()
    if (this.proc.exitCode === null) this.proc.kill(signal)
  }
}

function configOption(result: RpcObject, category: string): RpcObject | undefined {
  return Array.isArray(result.configOptions)
    ? result.configOptions.map(acpObject).find(option => option?.type === 'select' && (option.category === category || option.id === category))
    : undefined
}

function choices(value: unknown): AntigravityStatus['models'] {
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

let lastStatus: { binary: string; report: AntigravityStatus } | undefined
let pendingDiscovery: Promise<AntigravityStatus> | undefined

function report(status: AntigravityStatus['status'], extra?: Partial<AntigravityStatus>): AntigravityStatus {
  return { id: ANTIGRAVITY_PROVIDER_ID, kind: 'acp', status, models: [], ...extra }
}

export function getAntigravityStatus(): AntigravityStatus {
  const binary = executable()
  if (!binary) return report('not_installed')
  return lastStatus?.binary === binary ? lastStatus.report : report('unchecked')
}

export class AntigravityAcp {
  constructor(
    private readonly rpc: AntigravityRpc,
    readonly sessionId: string,
    readonly modelId: string | undefined,
    readonly supportsImages: boolean,
  ) {}

  get proc() { return this.rpc.proc }
  get drained() { return this.rpc.drained }
  get isOpen() { return this.rpc.isOpen }
  set onMessage(handler: AntigravityRpc['onMessage']) { this.rpc.onMessage = handler }
  prompt(prompt: unknown[]) { return this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt }, 0) }
  cancel() { return this.rpc.notify('session/cancel', { sessionId: this.sessionId }) }
  reply(id: RpcId, result?: RpcObject, errorCode?: number) { return this.rpc.reply(id, result, errorCode) }
  end() { this.rpc.end() }
  close(signal?: NodeJS.Signals) { this.rpc.close(signal) }
}

export async function openAntigravityAcp(cwd: string, nativeSessionId?: string, modelId = ANTIGRAVITY_DEFAULT_MODEL): Promise<AntigravityAcp> {
  const binary = executable()
  if (!binary) throw new AntigravityError('ANTIGRAVITY_NOT_INSTALLED', 'Install Antigravity CLI so `agy` is available on the server machine.')
  let networkEnv: Record<string, string>
  try {
    // 复用系统或手动网络代理；这不改变 AGY 的官方 API 端点或认证。
    networkEnv = buildNetworkEnvironment(await loadNetworkSettings())
  } catch {
    throw connectionError('Check the network proxy in Settings before connecting to Antigravity CLI.')
  }
  const rpc = new AntigravityRpc(binary, cwd, { ...process.env, ...networkEnv })
  try {
    const clientInfo = { name: 'cc-haha', version: '0.1.0' }
    const init = await rpc.request('initialize', { protocolVersion: 1, clientInfo, clientCapabilities: {} })
    if (init.protocolVersion !== 1) {
      throw new AntigravityError('ANTIGRAVITY_UNSUPPORTED', 'This version of Antigravity CLI did not negotiate ACP version 1. Update the CLI and retry.')
    }
    const capabilities = acpObject(init.agentCapabilities)
    const version = acpObject(init.agentInfo)?.version
    let result: RpcObject
    if (nativeSessionId) {
      if (!acpObject(capabilities?.sessionCapabilities)?.resume) {
        throw new AntigravityError('ANTIGRAVITY_RESUME_FAILED', 'This CLI cannot resume the saved Antigravity session. Start a new chat or update Antigravity CLI.')
      }
      try {
        result = await rpc.request('session/resume', { sessionId: nativeSessionId, cwd, mcpServers: [] })
      } catch (error) {
        if (error instanceof AntigravityError && error.code === 'ANTIGRAVITY_LOGIN_REQUIRED') throw error
        throw new AntigravityError('ANTIGRAVITY_RESUME_FAILED', 'Antigravity could not resume this saved session. Open a new chat if the original CLI history was removed.')
      }
    } else {
      // authMethods are offered even when signed in; session/new is authoritative.
      result = await rpc.request('session/new', { cwd, mcpServers: [] })
    }
    const nativeId = nativeSessionId ?? result.sessionId
    if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 512) throw connectionError('Antigravity did not return a valid ACP session ID.')

    const model = configOption(result, 'model')
    const models = choices(model?.options)
    const currentModelId = typeof model?.currentValue === 'string' ? model.currentValue : undefined
    const previous = lastStatus?.binary === binary && lastStatus.report.status === 'ready' ? lastStatus.report : undefined
    lastStatus = { binary, report: report('ready', {
      models: models.length > 0 ? models : previous?.models ?? [], currentModelId: nativeSessionId ? previous?.currentModelId : currentModelId,
      ...(typeof version === 'string' ? { version } : {}),
    }) }

    if (modelId !== ANTIGRAVITY_DEFAULT_MODEL && modelId !== currentModelId) {
      if (typeof model?.id !== 'string' || !models.some(option => option.id === modelId)) {
        throw new AntigravityError('ANTIGRAVITY_MODEL_UNAVAILABLE', `The selected model is not available to Antigravity. Refresh its models or choose the CLI default.`)
      }
      const selection = await rpc.request('session/set_config_option', { sessionId: nativeId, configId: model.id, value: modelId })
      if (configOption(selection, 'model')?.currentValue !== modelId) {
        throw new AntigravityError('ANTIGRAVITY_MODEL_UNAVAILABLE', 'Antigravity did not confirm the selected model. Refresh its models and try again.')
      }
    }
    const mode = configOption(result, 'mode')
    if (typeof mode?.id === 'string' && mode.currentValue !== 'default') {
      const selection = await rpc.request('session/set_config_option', { sessionId: nativeId, configId: mode.id, value: 'default' })
      if (configOption(selection, 'mode')?.currentValue !== 'default') throw connectionError('Antigravity did not confirm its default permission mode.')
    }
    return new AntigravityAcp(rpc, nativeId, modelId === ANTIGRAVITY_DEFAULT_MODEL ? currentModelId : modelId, acpObject(capabilities?.promptCapabilities)?.image === true)
  } catch (error) {
    rpc.close()
    if (error instanceof AntigravityError && error.code === 'ANTIGRAVITY_LOGIN_REQUIRED') {
      lastStatus = { binary, report: report('login_required') }
    }
    throw error
  }
}

export function discoverAntigravity(): Promise<AntigravityStatus> {
  if (pendingDiscovery) return pendingDiscovery
  pendingDiscovery = (async () => {
    const binary = executable()
    if (!binary) return report('not_installed')
    const cwd = await mkdtemp(join(tmpdir(), 'cchaha-agy-'))
    try {
      const acp = await openAntigravityAcp(cwd)
      acp.close()
      await acp.proc.exited
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
