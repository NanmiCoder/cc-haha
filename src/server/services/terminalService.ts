/**
 * 服务端终端服务（H5 终端桥接）
 *
 * 桌面端终端运行在 Electron 主进程（node-pty + IPC，desktop/electron/services/terminal.ts）。
 * H5 浏览器没有 Tauri/Electron 运行时，因此 sidecar 在服务进程内 spawn PTY，
 * 经独立 WebSocket 通道 /ws/terminal 桥接给浏览器端（见 ws/handler.ts 的
 * channel === 'terminal' 分支）。
 *
 * shell 解析 / env 构造 / cwd 解析与 Electron 端保持同语义（函数逐一对应
 * desktop/electron/services/terminal.ts 中同名导出），H5 与桌面共享同一份
 * settings.json 的 desktopTerminal 偏好与 terminal-config.json 的 bash_path。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

/**
 * 把一段字节解码为 UTF-8 文本。PTY 读取块边界可能正好切在多字节字符中间，
 * 因此把尾部不完整序列的残字节保留到下一次拼接（Bun 的 node:stream 不导出
 * StringDecoder，node 有；为运行时无关，这里自行实现最小版本）。
 * 返回 { text, tail }：text 为可安全解码部分，tail 为需拼接到下次的字节。
 */
function decodeUtf8Chunk(chunk: Buffer, carry: Buffer): { text: string, tail: Buffer } {
  const combined = carry.length === 0
    ? chunk
    : Buffer.concat([carry, chunk])
  if (combined.length === 0) return { text: '', tail: Buffer.alloc(0) }

  // 从末尾回退：跳过续字节（0x80-0xBF），定位最后一个码点的首字节
  let i = combined.length
  while (i > 0 && (combined[i - 1] & 0xC0) === 0x80) i -= 1
  if (i === 0) {
    // 整段都是续字节（仅可能出现在 carry 场景）：全部留待下次
    return { text: '', tail: combined }
  }
  const lead = combined[i - 1]
  const need = lead < 0x80 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4
  const available = combined.length - i + 1
  if (available < need) {
    return {
      text: combined.subarray(0, i - 1).toString('utf8'),
      tail: combined.subarray(i - 1),
    }
  }
  return { text: combined.toString('utf8'), tail: Buffer.alloc(0) }
}

export const TERMINAL_CONFIG_FILE = 'terminal-config.json'
export const MIN_TERMINAL_COLS = 20
export const MIN_TERMINAL_ROWS = 8
const DEFAULT_DISCONNECT_GRACE_MS = 15_000

export type TerminalSpawnInput = {
  requestId?: string
  cols?: number
  rows?: number
  cwd?: string
}

export type TerminalSpawnResult = {
  session_id: number
  shell: string
  cwd: string
}

export type TerminalPtyProcess = {
  pid?: number
  process?: string
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(handler: (data: string) => void): unknown
  onExit(handler: (event: { exitCode: number, signal?: number | string | null }) => void): unknown
}

export type TerminalPtySpawnOptions = {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export type TerminalPtyFactory = {
  spawn(shell: string, args: string[], options: TerminalPtySpawnOptions): TerminalPtyProcess
}

/** 终端 WS 连接的最小形状：服务只负责把输出帧 send 回去。 */
export type TerminalSocket = {
  send(data: string): void
}

type DesktopTerminalConfig = {
  startupShell?: string | null
  customShellPath?: string | null
}

type TerminalConfig = Record<string, unknown> & {
  bash_path?: string | null
}

type TerminalSession = {
  sessionId: number
  pty: TerminalPtyProcess
  shell: string
  cwd: string
  owner: TerminalSocket | null
  graceTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
}

export type TerminalServiceOptions = {
  ptyFactory?: TerminalPtyFactory | (() => Promise<TerminalPtyFactory>)
  /** 测试/部署覆盖 node-pty 目录，优先于其它候选。 */
  nodePtyDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  cwd?: () => string
  /** 覆盖 WS 断开后的宽限期（毫秒）。默认 15s，可用 CC_HAHA_TERMINAL_DISCONNECT_GRACE_SECONDS 调整。 */
  graceMs?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ─── node-pty 定位 ───────────────────────────────────────────────────────────
// node-pty 是 desktop 的原生依赖（desktop/node_modules/node-pty），sidecar 进程
// 从仓库根/安装目录运行，无法直接 import('node-pty')，必须按绝对路径
// createRequire 加载（Bun 下已验证可行）。

export function findNodePtyDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  const candidates: string[] = []
  const override = env.CC_HAHA_NODE_PTY_DIR?.trim()
  if (override) candidates.push(override)

  const appRoot = env.CLAUDE_APP_ROOT?.trim()
  if (appRoot) {
    if (appRoot.endsWith('.asar')) {
      // electron-builder asarUnpack：app.asar 同级目录生成 app.asar.unpacked。
      candidates.push(
        path.join(path.dirname(appRoot), `${path.basename(appRoot)}.unpacked`, 'node_modules', 'node-pty'),
      )
    }
    candidates.push(path.join(appRoot, 'node_modules', 'node-pty'))
    // dev：appRoot 是仓库根，node-pty 装在 desktop 工作区。
    candidates.push(path.join(appRoot, 'desktop', 'node_modules', 'node-pty'))
  }

  candidates.push(path.join(cwd, 'desktop', 'node_modules', 'node-pty'))

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(path.join(dir, 'package.json'))) continue
      if (fs.existsSync(path.join(dir, 'build', 'Release', 'pty.node'))) return dir
      const prebuilt = path.join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node')
      if (fs.existsSync(prebuilt)) return dir
    } catch {
      // 候选目录不可读则继续
    }
  }
  return null
}

/** 原生 pty.node 模块的最小形状（node-pty 的 N-API 绑定，跳过其 JS 胶水层）。 */
export type NodePtyNativeModule = {
  fork(
    file: string,
    args: string[],
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    uid: number,
    gid: number,
    utf8: boolean,
    helperPath: string,
    onexit: (code: number | null, signal: number | null) => void,
  ): { fd: number; pid: number; pty: string }
  resize(fd: number, cols: number, rows: number): void
}

/**
 * node-pty 的 JS 胶水层（lib/unixTerminal.js）用 `new tty.ReadStream(fd)` 读
 * pty master fd。Node 下非阻塞 fd 遇到 EAGAIN 会让流保持打开；**Bun 下首次
 * EAGAIN 即关闭流**，触发 close 回调进而 SIGHUP 掉 shell（spawn 后 ~12ms 退出，
 * exitCode 0 / signal 1）。sidecar 运行时恒为 Bun（dev `bun run`、prod 用
 * `bun compile` 出的二进制），因此 H5 终端必须绕过该胶水层，直接调原生
 * `pty.node` 的 `fork` 并手动非阻塞读 master fd。
 */
export function createNativePtyFactory(
  native: NodePtyNativeModule,
  nodePtyDir: string,
): TerminalPtyFactory {
  const helperPath = path.join(nodePtyDir, 'build', 'Release', 'spawn-helper')
  return {
    spawn(shell: string, args: string[], options: TerminalPtySpawnOptions): TerminalPtyProcess {
      return new NativePtyProcess(native, helperPath, shell, args, options)
    },
  }
}

export function loadNodePtyFactory(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): TerminalPtyFactory {
  const dir = findNodePtyDir(env, cwd)
  if (!dir) {
    throw new Error(
      `terminal node-pty runtime not found (tried: `
      + [
        env.CC_HAHA_NODE_PTY_DIR ?? '(env unset)',
        env.CLAUDE_APP_ROOT ?? '(app-root unset)',
        path.join(cwd, 'desktop', 'node_modules', 'node-pty'),
      ].join(', ') + ')',
    )
  }
  // 优先原生 build/Release/pty.node（跳过 JS 胶水层）；Linux 无 prebuilds。
  const requireFromNodePty = createRequire(path.join(dir, 'package.json'))
  const native = requireFromNodePty(path.join(dir, 'build', 'Release', 'pty.node')) as NodePtyNativeModule
  return createNativePtyFactory(native, dir)
}

/**
 * Bun 兼容的 PTY 进程封装：直接持有原生 pty fork 出来的 master fd，
 * 用异步 `fs.read` 非阻塞轮询读取（EAGAIN 时短退避，EIO 表示子进程退出）。
 * 实现与 TerminalPtyProcess 接口一致，TerminalService 逻辑无需感知运行环境。
 * 退避 20ms 时空闲 CPU 约 24%，可接受（v1）。
 */
class NativePtyProcess implements TerminalPtyProcess {
  pid: number
  private fd: number
  private native: NodePtyNativeModule
  private writeQueue: string[] = []
  private flushing = false
  private dataHandler: ((data: string) => void) | null = null
  private exitHandler: ((event: { exitCode: number, signal?: number | string | null }) => void) | null = null
  private carry = Buffer.alloc(0)
  private exitSent = false
  private stopped = false

  constructor(
    native: NodePtyNativeModule,
    helperPath: string,
    shell: string,
    args: string[],
    options: TerminalPtySpawnOptions,
  ) {
    this.native = native
    const envPairs = Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
    const term = native.fork(
      shell,
      args,
      envPairs,
      options.cwd,
      options.cols,
      options.rows,
      -1,
      -1,
      true,
      helperPath,
      (code, signal) => this.handleExit(code, signal),
    )
    this.fd = term.fd
    this.pid = term.pid
    this.startReading()
  }

  write(data: string): void {
    if (this.stopped) return
    if (typeof data === 'string' && data.length > 0) {
      this.writeQueue.push(data)
      this.flushWrites()
    }
  }

  resize(cols: number, rows: number): void {
    this.native.resize(this.fd, cols, rows)
  }

  kill(): void {
    try {
      process.kill(this.pid, 'SIGHUP')
    } catch {
      // 进程已退出，忽略
    }
  }

  onData(handler: (data: string) => void): unknown {
    this.dataHandler = handler
  }

  onExit(handler: (event: { exitCode: number, signal?: number | string | null }) => void): unknown {
    this.exitHandler = handler
  }

  private startReading(): void {
    this.armRead()
  }

  private armRead(): void {
    if (this.stopped) return
    const buffer = Buffer.alloc(65536)
    fs.read(this.fd, buffer, 0, buffer.length, null, (err, bytesRead) => {
      if (this.stopped) return
      if (err) {
        const code = err.code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
          // master 端暂无数据：短退避后重试，避免空转占满 CPU
          setTimeout(() => this.armRead(), 20)
          return
        }
        if (code === 'EIO') {
          // 子进程退出，master 侧读端关闭。退出事件以原生 waitpid 回调为
          // 权威（code/signal 更准确）；这里只停读循环，并加短兜底防止
          // onexit 回调因异常未触发导致会话永不回收。
          this.stop()
          setTimeout(() => {
            if (!this.exitSent) this.emitExit(0, 1)
          }, 200)
          return
        }
        this.stop()
        return
      }
      if (bytesRead > 0) {
        const decoded = decodeUtf8Chunk(buffer.subarray(0, bytesRead), this.carry)
        this.carry = decoded.tail
        if (decoded.text && this.dataHandler) this.dataHandler(decoded.text)
        // 有数据立即再读，排空内核缓冲区
        this.armRead()
        return
      }
      this.armRead()
    })
  }

  private flushWrites(): void {
    if (this.flushing || this.stopped) return
    this.flushing = true
    const chunk = this.writeQueue.shift()
    if (chunk === undefined) {
      this.flushing = false
      return
    }
    fs.write(this.fd, chunk, (err) => {
      if (this.stopped) {
        this.flushing = false
        return
      }
      if (err && (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK')) {
        this.writeQueue.unshift(chunk)
        setImmediate(() => this.flushWrites())
        return
      }
      if (err && err.code !== 'EIO') {
        // 写端已关闭（子进程退出）：丢弃后续写入
        this.writeQueue = []
        this.flushing = false
        return
      }
      this.flushing = false
      this.flushWrites()
    })
  }

  private handleExit(code: number | null, signal: number | null): void {
    const exitCode = code ?? (signal === null ? 0 : signal)
    this.emitExit(exitCode, signal ?? undefined)
  }

  private emitExit(code: number, signal: number | string | null | undefined): void {
    if (this.exitSent) return
    this.exitSent = true
    if (this.exitHandler) {
      this.exitHandler({ exitCode: code, signal: signal == null ? null : signal })
    }
  }

  private stop(): void {
    this.stopped = true
  }
}

// ─── shell / env / cwd 解析（与 desktop/electron/services/terminal.ts 同语义）─

export function normalizeTerminalBashPath(
  value: unknown,
  isFile: (filePath: string) => boolean = filePath => {
    try {
      return fs.statSync(filePath).isFile()
    } catch {
      return false
    }
  },
): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return null
  if (!isFile(trimmed)) {
    throw new Error(`terminal bash path does not exist: ${trimmed}`)
  }
  return trimmed
}

export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  customBashPath: unknown = null,
  fileExists: (filePath: string) => boolean = fs.existsSync,
): string {
  if (platform === 'win32') {
    const bashPath = typeof customBashPath === 'string' ? customBashPath.trim() : ''
    if (bashPath && fileExists(bashPath)) return bashPath
    return env.COMSPEC || 'powershell.exe'
  }

  return env.SHELL || (fileExists('/bin/zsh') ? '/bin/zsh' : '/bin/bash')
}

export function resolveDesktopTerminalShell(
  platform: NodeJS.Platform,
  config: DesktopTerminalConfig | null | undefined,
): string | null {
  if (platform !== 'win32' || !config) return null
  const startupShell = typeof config.startupShell === 'string'
    ? config.startupShell.trim()
    : undefined
  switch (startupShell) {
    case undefined:
    case '':
    case 'system':
      return null
    case 'pwsh':
      return 'pwsh.exe'
    case 'powershell':
      return 'powershell.exe'
    case 'cmd':
      return 'cmd.exe'
    case 'custom': {
      const customShellPath = typeof config.customShellPath === 'string'
        ? config.customShellPath.trim()
        : ''
      if (!customShellPath) throw new Error('custom terminal shell path is empty')
      return customShellPath
    }
    default:
      return null
  }
}

export function ensureUtf8Locale(env: Record<string, string>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const fallback = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  for (const key of ['LANG', 'LC_CTYPE', 'LC_ALL']) {
    const value = env[key]
    if (!value || !value.trim().toLowerCase().replace(/-/g, '').includes('utf8')) {
      env[key] = fallback
    }
  }
  return env
}

export function parseEnvBlock(buffer: Buffer): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of buffer.toString('utf8').split('\0')) {
    if (!entry) continue
    const equals = entry.indexOf('=')
    if (equals <= 0) continue
    env[entry.slice(0, equals)] = entry.slice(equals + 1)
  }
  return env
}

export function loginShellEnvironment(shell: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform === 'win32') return {}
  try {
    const stdout = execFileSync(shell, ['-l', '-c', 'env -0'], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
    return parseEnvBlock(stdout)
  } catch {
    return {}
  }
}

export function terminalEnvironment(
  shell: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') merged[key] = value
  }
  Object.assign(merged, loginShellEnvironment(shell, platform))
  return ensureUtf8Locale(merged, platform)
}

export function resolveTerminalCwd(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  currentDirectory: () => string = process.cwd,
): string {
  const trimmed = cwd?.trim()
  const resolved = trimmed
    || env.CLAUDE_CONFIG_DIR
    || env.HOME
    || env.USERPROFILE
    || currentDirectory()
  let isDirectory = false
  try {
    isDirectory = fs.statSync(resolved).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    throw new Error(`terminal cwd does not exist: ${resolved}`)
  }
  return resolved
}

// ─── 配置读写（与 Electron 端同一份文件）─────────────────────────────────────

function configDir(env: NodeJS.ProcessEnv): string {
  const portableDir = env.CLAUDE_CONFIG_DIR?.trim()
  if (portableDir) return portableDir
  return path.join(os.homedir(), '.claude')
}

function readDesktopTerminalConfig(env: NodeJS.ProcessEnv): DesktopTerminalConfig | null {
  const settingsPath = path.join(configDir(env), 'settings.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.desktopTerminal)) return null
    const startupShell = typeof parsed.desktopTerminal.startupShell === 'string'
      ? parsed.desktopTerminal.startupShell
      : null
    const customShellPath = typeof parsed.desktopTerminal.customShellPath === 'string'
      ? parsed.desktopTerminal.customShellPath
      : null
    const normalizedStartupShell = startupShell?.trim() ?? ''
    if (!['', 'system', 'pwsh', 'powershell', 'cmd', 'custom'].includes(normalizedStartupShell)) {
      return null
    }
    if (normalizedStartupShell === 'custom' && !customShellPath?.trim()) {
      return null
    }
    return {
      startupShell,
      customShellPath,
    }
  } catch {
    return null
  }
}

function loadTerminalConfig(env: NodeJS.ProcessEnv): TerminalConfig {
  const configPath = path.join(configDir(env), TERMINAL_CONFIG_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown
    if (!isRecord(parsed)) return {}
    const config: TerminalConfig = { ...parsed }
    if (typeof config.bash_path !== 'string' && config.bash_path !== null) {
      delete config.bash_path
    }
    return config
  } catch {
    return {}
  }
}

function saveTerminalConfig(env: NodeJS.ProcessEnv, config: TerminalConfig): void {
  const configPath = path.join(configDir(env), TERMINAL_CONFIG_FILE)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

// ─── TerminalService ─────────────────────────────────────────────────────────

export class TerminalService {
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly ptyFactory?: TerminalPtyFactory | (() => Promise<TerminalPtyFactory>)
  private readonly nodePtyDir?: string
  private readonly cwd: () => string
  private readonly graceMs: number
  private nextSessionId = 1
  private readonly sessions = new Map<number, TerminalSession>()

  constructor(options: TerminalServiceOptions = {}) {
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.ptyFactory = options.ptyFactory
    this.nodePtyDir = options.nodePtyDir
    this.cwd = options.cwd ?? process.cwd
    this.graceMs = options.graceMs ?? this.graceMsFromEnv()
  }

  private graceMsFromEnv(): number {
    const seconds = Number(this.env?.CC_HAHA_TERMINAL_DISCONNECT_GRACE_SECONDS)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
    return DEFAULT_DISCONNECT_GRACE_MS
  }

  getBashPath(): string | null {
    return loadTerminalConfig(this.env).bash_path ?? null
  }

  setBashPath(value: string | null): void {
    const config = loadTerminalConfig(this.env)
    config.bash_path = normalizeTerminalBashPath(value)
    saveTerminalConfig(this.env, config)
  }

  resolveShell(): string {
    const terminalConfig = loadTerminalConfig(this.env)
    const systemDefault = defaultShell(
      this.platform,
      this.env,
      terminalConfig.bash_path ?? null,
      fs.existsSync,
    )
    return resolveDesktopTerminalShell(this.platform, readDesktopTerminalConfig(this.env)) ?? systemDefault
  }

  /** WS 连接建立：接管仍存活的 PTY（断线重连续接），并回发 terminal_sync。 */
  attach(ws: TerminalSocket): void {
    let tookOver = false
    for (const session of this.sessions.values()) {
      if (session.exited) continue
      if (session.graceTimer) {
        clearTimeout(session.graceTimer)
        session.graceTimer = null
      }
      session.owner = ws
      tookOver = true
    }
    if (tookOver) {
      this.sendTo(ws, {
        type: 'terminal_sync',
        sessions: [...this.sessions.values()].filter(s => !s.exited).map(s => ({
          session_id: s.sessionId,
          shell: s.shell,
          cwd: s.cwd,
        })),
      })
    }
  }

  /** WS 断开：PTY 不立即杀，给宽限期吸收网络闪断；超时或显式 kill/退出才回收。 */
  detach(ws: TerminalSocket): void {
    for (const session of this.sessions.values()) {
      if (session.exited || session.owner !== ws) continue
      session.owner = null
      this.scheduleGraceKill(session)
    }
  }

  async spawn(ws: TerminalSocket, input: TerminalSpawnInput): Promise<TerminalSpawnResult> {
    const correlation = typeof input.requestId === 'string' && input.requestId.length > 0
      ? { requestId: input.requestId } : {}
    const cols = Math.max(MIN_TERMINAL_COLS, Math.floor(input.cols ?? 80))
    const rows = Math.max(MIN_TERMINAL_ROWS, Math.floor(input.rows ?? 24))
    const cwd = resolveTerminalCwd(input.cwd, this.env, this.cwd)
    const shell = this.resolveShell()

    const ptyFactory = this.ptyFactory
      ? (typeof this.ptyFactory === 'function' ? await this.ptyFactory() : this.ptyFactory)
      : loadNodePtyFactory(this.nodePtyDir
        ? { ...this.env, CC_HAHA_NODE_PTY_DIR: this.nodePtyDir }
        : this.env, this.cwd())

    const sessionId = this.nextSessionId++
    let pty: TerminalPtyProcess
    try {
      pty = ptyFactory.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...terminalEnvironment(shell, this.platform, this.env),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      })
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }

    const session: TerminalSession = {
      sessionId,
      pty,
      shell,
      cwd,
      owner: ws,
      graceTimer: null,
      exited: false,
    }
    this.sessions.set(sessionId, session)
    pty.onData(data => {
      if (this.sessions.get(sessionId) !== session) return
      if (!session.owner) return
      this.sendTo(session.owner, {
        type: 'terminal_output',
        ...correlation,
        session_id: sessionId,
        data,
      })
    })

    pty.onExit(({ exitCode, signal }) => {
      const removed = this.removeSession(sessionId, pty)
      if (!removed) return
      if (session.owner) {
        this.sendTo(session.owner, {
          type: 'terminal_exited',
          ...correlation,
          session_id: sessionId,
          code: exitCode,
          signal: signal == null ? null : String(signal),
        })
      }
    })

    return {
      session_id: sessionId,
      shell,
      cwd,
    }
  }

  write(ws: TerminalSocket, sessionId: number, data: string): void {
    this.getSession(ws, sessionId).pty.write(data)
  }

  resize(ws: TerminalSocket, sessionId: number, cols: number, rows: number): void {
    this.getSession(ws, sessionId).pty.resize(
      Math.max(MIN_TERMINAL_COLS, Math.floor(cols)),
      Math.max(MIN_TERMINAL_ROWS, Math.floor(rows)),
    )
  }

  kill(ws: TerminalSocket, sessionId: number): void {
    const session = this.getSession(ws, sessionId)
    this.stopSession(sessionId, session)
  }

  killAll(): void {
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      this.stopSession(sessionId, session)
    }
  }

  listSessions(): Array<{ session_id: number, shell: string, cwd: string }> {
    return [...this.sessions.values()].filter(s => !s.exited).map(s => ({
      session_id: s.sessionId,
      shell: s.shell,
      cwd: s.cwd,
    }))
  }

  private getSession(ws: TerminalSocket, sessionId: number): TerminalSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('terminal session is not running')
    if (session.owner !== ws) {
      throw new Error('terminal session is owned by another client')
    }
    return session
  }

  private scheduleGraceKill(session: TerminalSession): void {
    const sessionId = session.sessionId
    if (session.graceTimer) return
    session.graceTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId)
      if (!current || current !== session) return
      current.graceTimer = null
      console.log(`[Terminal] Grace period expired for session ${sessionId}; killing shell`)
      this.stopSession(sessionId, session)
    }, this.graceMs)
    session.graceTimer.unref?.()
  }

  private stopSession(sessionId: number, session: TerminalSession): void {
    if (this.sessions.get(sessionId) !== session) return
    if (session.graceTimer) {
      clearTimeout(session.graceTimer)
      session.graceTimer = null
    }
    // 显式 kill / 宽限超时：置 exited 停止转发与列出，但不立即从 map 删除，
    // 让 pty 的真实退出事件走 removeSession 路径发出 terminal_exited 帧并清理
    // （与桌面端一致：kill 只杀 pty，exit 事件回帧）。
    session.exited = true
    try {
      session.pty.kill()
    } catch {
      // 回收路径上的原生 kill 错误不应冒泡到 WS 断开处理
    }
    // 兜底：极少数情况下 pty 退出事件未及时到达，确保 map 不泄漏
    const cleanup = setTimeout(() => {
      const current = this.sessions.get(sessionId)
      if (current === session && current.exited) this.sessions.delete(sessionId)
    }, 500)
    cleanup.unref?.()
  }

  private removeSession(sessionId: number, expectedPty: TerminalPtyProcess): TerminalSession | null {
    const session = this.sessions.get(sessionId)
    if (!session || session.pty !== expectedPty) return null
    if (session.graceTimer) {
      clearTimeout(session.graceTimer)
      session.graceTimer = null
    }
    session.exited = true
    this.sessions.delete(sessionId)
    return session
  }

  private sendTo(ws: TerminalSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      // 发送窗口已关闭；close 事件会触发 detach/宽限回收
    }
  }
}

let terminalServiceSingleton: TerminalService | null = null

export function getTerminalService(): TerminalService {
  if (!terminalServiceSingleton) {
    terminalServiceSingleton = new TerminalService()
  }
  return terminalServiceSingleton
}
