import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'

const TERMINAL_CONFIG_FILE = 'terminal-config.json'
const MIN_TERMINAL_COLS = 20
const MIN_TERMINAL_ROWS = 8
const NODE_PTY_MANIFEST_FILE = '.cc-haha-node-pty-manifest.json'
const MACOS_DOWNLOAD_XATTRS = ['com.apple.quarantine', 'com.apple.provenance']

export type TerminalSpawnInput = {
  cols?: number
  rows?: number
  cwd?: string
}

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

export type TerminalAppLike = {
  getPath(name: 'home' | 'userData'): string
}

export type TerminalWebContentsLike = {
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
  /**
   * A reload does not emit `destroyed`, so `destroyed` alone leaks every PTY on the
   * paths that reload the renderer deliberately: render-process-gone and sustained
   * unresponsive recovery in rendererLifecycle.ts, plus the reload buttons in
   * ErrorBoundary and StartupErrorView. Session bookkeeping lives in renderer module
   * state and is wiped by the reload, so kill() can never be called for those shells
   * again — they and their children survive until before-quit.
   *
   * `did-navigate`, not `did-start-navigation`: killing a shell is destructive and
   * must be gated on the navigation actually committing. installMainWindowNavigationGuards
   * cancels external http(s) navigation in `will-navigate` and hands it to the system
   * browser — but Chromium dispatches DidStartNavigation before the throttle that
   * cancellation runs in, so a *blocked* navigation still emits the start event. Dropping
   * a URL onto the window would then have killed every running shell while the renderer
   * stayed exactly where it was. A cancelled navigation never commits, so it never
   * reaches this one. Electron also does not emit it for in-page navigation, which is
   * why no same-document predicate is needed.
   */
  on(event: 'did-navigate', listener: TerminalNavigationListener): unknown
  /**
   * `off`, not a second `removeListener` overload: a target type with two call
   * signatures is not structurally assignable from Electron's overloaded
   * `removeListener`, so adding one there rejects the real `WebContents`.
   */
  off(event: 'did-navigate', listener: TerminalNavigationListener): unknown
}

// Zero-arg on purpose: the handler ignores every argument, and a narrower parameter
// list is what keeps this structurally assignable from both Electron's overloaded
// `on` and a plain EventEmitter in the tests.
type TerminalNavigationListener = () => void

export type ElectronTerminalServiceOptions = {
  app?: TerminalAppLike
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  ptyFactory?: TerminalPtyFactory | (() => Promise<TerminalPtyFactory>)
  nodePtySourceDir?: string
  nodePtyCacheDir?: string
  fileExists?: (filePath: string) => boolean
  isFile?: (filePath: string) => boolean
  cwd?: () => string
}

type TerminalConfig = Record<string, unknown> & {
  bash_path?: string | null
}

type DesktopTerminalConfig = {
  startupShell?: string | null
  customShellPath?: string | null
}

type TerminalSession = {
  pty: TerminalPtyProcess
  owner: TerminalWebContentsLike
  onOwnerDestroyed: () => void
  onOwnerNavigated: TerminalNavigationListener
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function sendTerminalEvent(
  webContents: TerminalWebContentsLike,
  channel: string,
  payload: TerminalOutputPayload | TerminalExitPayload,
): void {
  if (webContents.isDestroyed()) return

  try {
    webContents.send(channel, payload)
  } catch (error) {
    // The renderer can be destroyed between the isDestroyed check and send.
    if (error instanceof Error && error.message === 'Object has been destroyed') return
    throw error
  }
}

const preparedNodePtyDirs = new Set<string>()

export function terminalConfigPath(app: TerminalAppLike | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const portableDir = env.CLAUDE_CONFIG_DIR?.trim()
  if (portableDir) {
    return path.join(portableDir, TERMINAL_CONFIG_FILE)
  }
  if (!app) return null
  return path.join(app.getPath('home'), '.claude', TERMINAL_CONFIG_FILE)
}

export function claudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const portableDir = env.CLAUDE_CONFIG_DIR?.trim()
  if (portableDir) return portableDir
  const home = platform === 'win32'
    ? env.USERPROFILE || os.homedir()
    : env.HOME || os.homedir()
  return home ? path.join(home, '.claude') : null
}

export function desktopTerminalSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const dir = claudeConfigDir(env, platform)
  return dir ? path.join(dir, 'settings.json') : null
}

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

export function readDesktopTerminalConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DesktopTerminalConfig | null {
  const settingsPath = desktopTerminalSettingsPath(env, platform)
  if (!settingsPath) return null
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

function loadTerminalConfig(app: TerminalAppLike | undefined, env: NodeJS.ProcessEnv): TerminalConfig {
  const configPath = terminalConfigPath(app, env)
  if (!configPath) return {}
  const candidates = [configPath]
  if (app && !env.CLAUDE_CONFIG_DIR) {
    candidates.push(path.join(app.getPath('userData'), TERMINAL_CONFIG_FILE))
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown
      if (!isRecord(parsed)) continue
      const config: TerminalConfig = { ...parsed }
      if (typeof config.bash_path !== 'string' && config.bash_path !== null) {
        delete config.bash_path
      }
      return config
    } catch {
      // Try the old Electron userData location before using defaults.
    }
  }
  return {}
}

function saveTerminalConfig(app: TerminalAppLike | undefined, env: NodeJS.ProcessEnv, config: TerminalConfig) {
  const configPath = terminalConfigPath(app, env)
  if (!configPath) throw new Error('terminal config path is unavailable')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
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

function ensureNodePtyHelpersExecutable(moduleDir: string): void {
  const prebuildsDir = path.join(moduleDir, 'prebuilds')
  if (!fs.existsSync(prebuildsDir)) return

  for (const platformDir of fs.readdirSync(prebuildsDir)) {
    const helperPath = path.join(prebuildsDir, platformDir, 'spawn-helper')
    if (!fs.existsSync(helperPath)) continue

    const stat = fs.statSync(helperPath)
    if (!stat.isFile()) continue
    fs.chmodSync(helperPath, 0o500)
  }
}

type NodePtyIntegrityManifest = {
  version: 1
  files: Array<{ path: string, sha256: string }>
}

function walkNodePtyFiles(rootDir: string): string[] {
  const results: string[] = []
  const stack = [rootDir]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name !== NODE_PTY_MANIFEST_FILE) {
        results.push(fullPath)
      }
    }
  }

  return results.sort()
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function buildNodePtyManifest(moduleDir: string): NodePtyIntegrityManifest {
  return {
    version: 1,
    files: walkNodePtyFiles(moduleDir).map(filePath => ({
      path: path.relative(moduleDir, filePath).replaceAll(path.sep, '/'),
      sha256: hashFile(filePath),
    })),
  }
}

function manifestsEqual(left: NodePtyIntegrityManifest, right: NodePtyIntegrityManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function readNodePtyManifest(moduleDir: string): NodePtyIntegrityManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(moduleDir, NODE_PTY_MANIFEST_FILE), 'utf8')) as NodePtyIntegrityManifest
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) return null
    return parsed
  } catch {
    return null
  }
}

function writeNodePtyManifest(moduleDir: string, manifest: NodePtyIntegrityManifest): void {
  fs.writeFileSync(path.join(moduleDir, NODE_PTY_MANIFEST_FILE), JSON.stringify(manifest, null, 2), { mode: 0o600 })
}

function chmodNodePtyDirectories(moduleDir: string): void {
  for (const dir of [path.dirname(moduleDir), moduleDir]) {
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      // Best effort: chmod can fail on some filesystems, but the cache is still rebuilt from the bundle.
    }
  }
}

function stripMacosDownloadAttributes(moduleDir: string): void {
  if (process.platform !== 'darwin') return

  for (const attr of MACOS_DOWNLOAD_XATTRS) {
    try {
      execFileSync('/usr/bin/xattr', ['-dr', attr, moduleDir], { stdio: 'ignore' })
    } catch {
      // Best effort: the attribute may be absent, but stale quarantine blocks copied .node files.
    }
  }

  for (const filePath of walkNodePtyFiles(moduleDir)) {
    let originalMode: number | null = null
    try {
      const stat = fs.statSync(filePath)
      const mode = stat.mode & 0o777
      if ((mode & 0o200) === 0) {
        originalMode = mode
        fs.chmodSync(filePath, mode | 0o200)
      }
      for (const attr of MACOS_DOWNLOAD_XATTRS) {
        try {
          execFileSync('/usr/bin/xattr', ['-d', attr, filePath], { stdio: 'ignore' })
        } catch {
          // Best effort: only files that still carry download xattrs need this fallback.
        }
      }
    } catch {
      // Best effort: a partially rebuilt cache will be removed and copied again later.
    } finally {
      if (originalMode != null) {
        try {
          fs.chmodSync(filePath, originalMode)
        } catch {
          // Best effort: helper executable bits are restored separately before loading node-pty.
        }
      }
    }
  }
}

function isNodePtyCacheCurrent(sourceManifest: NodePtyIntegrityManifest, cacheDir: string): boolean {
  const cacheManifest = readNodePtyManifest(cacheDir)
  if (!cacheManifest || !manifestsEqual(sourceManifest, cacheManifest)) return false

  try {
    return manifestsEqual(sourceManifest, buildNodePtyManifest(cacheDir))
  } catch {
    return false
  }
}

export function prepareNodePtyRuntime(sourceDir: string, cacheDir: string): string {
  if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
    throw new Error(`node-pty source directory is missing: ${sourceDir}`)
  }
  const sourceManifest = buildNodePtyManifest(sourceDir)

  if (preparedNodePtyDirs.has(cacheDir) && isNodePtyCacheCurrent(sourceManifest, cacheDir)) {
    stripMacosDownloadAttributes(cacheDir)
    return cacheDir
  }
  if (!preparedNodePtyDirs.has(cacheDir) && isNodePtyCacheCurrent(sourceManifest, cacheDir)) {
    stripMacosDownloadAttributes(cacheDir)
    preparedNodePtyDirs.add(cacheDir)
    return cacheDir
  }

  fs.rmSync(cacheDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true, mode: 0o700 })
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  fs.cpSync(sourceDir, cacheDir, { recursive: true })
  stripMacosDownloadAttributes(cacheDir)
  ensureNodePtyHelpersExecutable(cacheDir)
  chmodNodePtyDirectories(cacheDir)
  if (!manifestsEqual(sourceManifest, buildNodePtyManifest(cacheDir))) {
    throw new Error('node-pty runtime cache integrity check failed')
  }
  writeNodePtyManifest(cacheDir, sourceManifest)
  preparedNodePtyDirs.add(cacheDir)
  return cacheDir
}

async function loadNodePtyFactory(sourceDir?: string, cacheDir?: string): Promise<TerminalPtyFactory> {
  if (sourceDir && cacheDir) {
    const moduleDir = prepareNodePtyRuntime(sourceDir, cacheDir)
    const requireFromNodePty = createRequire(path.join(moduleDir, 'package.json'))
    return requireFromNodePty(moduleDir) as TerminalPtyFactory
  }

  return import('node-pty') as Promise<TerminalPtyFactory>
}

async function resolvePtyFactory(
  factory: TerminalPtyFactory | (() => Promise<TerminalPtyFactory>) | undefined,
  nodePtySourceDir: string | undefined,
  nodePtyCacheDir: string | undefined,
): Promise<TerminalPtyFactory> {
  if (!factory) return loadNodePtyFactory(nodePtySourceDir, nodePtyCacheDir)
  if (typeof factory === 'function') return factory()
  return factory
}

export class ElectronTerminalService {
  private readonly app?: TerminalAppLike
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly ptyFactory?: TerminalPtyFactory | (() => Promise<TerminalPtyFactory>)
  private readonly nodePtySourceDir?: string
  private readonly nodePtyCacheDir?: string
  private readonly fileExists: (filePath: string) => boolean
  private readonly isFile: (filePath: string) => boolean
  private readonly cwd: () => string
  private nextSessionId = 1
  private readonly sessions = new Map<number, TerminalSession>()

  constructor(options: ElectronTerminalServiceOptions = {}) {
    this.app = options.app
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.ptyFactory = options.ptyFactory
    this.nodePtySourceDir = options.nodePtySourceDir
    this.nodePtyCacheDir = options.nodePtyCacheDir
    this.fileExists = options.fileExists ?? fs.existsSync
    this.isFile = options.isFile ?? (filePath => {
      try {
        return fs.statSync(filePath).isFile()
      } catch {
        return false
      }
    })
    this.cwd = options.cwd ?? process.cwd
  }

  getBashPath(): string | null {
    return loadTerminalConfig(this.app, this.env).bash_path ?? null
  }

  setBashPath(value: string | null): void {
    const config = loadTerminalConfig(this.app, this.env)
    config.bash_path = normalizeTerminalBashPath(value, this.isFile)
    saveTerminalConfig(this.app, this.env, config)
  }

  resolveShell(): string {
    const terminalConfig = loadTerminalConfig(this.app, this.env)
    const systemDefault = defaultShell(
      this.platform,
      this.env,
      terminalConfig.bash_path ?? null,
      this.fileExists,
    )
    return resolveDesktopTerminalShell(this.platform, readDesktopTerminalConfig(this.env, this.platform)) ?? systemDefault
  }

  async spawn(input: TerminalSpawnInput, webContents: TerminalWebContentsLike): Promise<TerminalSpawnResult> {
    const cols = Math.max(MIN_TERMINAL_COLS, Math.floor(input.cols ?? 80))
    const rows = Math.max(MIN_TERMINAL_ROWS, Math.floor(input.rows ?? 24))
    const cwd = resolveTerminalCwd(input.cwd, this.env, this.cwd)
    const shell = this.resolveShell()
    let rendererDestroyed = webContents.isDestroyed()
    if (rendererDestroyed) throw new Error('terminal renderer is destroyed')

    let sessionId: number | null = null
    let pty: TerminalPtyProcess | null = null
    let ptyDisposed = false
    const disposePty = () => {
      if (!pty || ptyDisposed) return
      ptyDisposed = true
      try {
        pty.kill()
      } catch {
        // Renderer teardown must not surface a native PTY kill error.
      }
    }
    const onOwnerDestroyed = () => {
      rendererDestroyed = true
      if (sessionId === null || !pty) return
      const active = this.sessions.get(sessionId)
      if (active?.pty !== pty) return
      this.sessions.delete(sessionId)
      this.detachOwnerListener(active)
      disposePty()
    }
    // Same teardown, second trigger: the renderer having replaced its document discards
    // the session ids this PTY can only be reached through, so it is as final as destroy.
    const onOwnerNavigated: TerminalNavigationListener = () => {
      onOwnerDestroyed()
    }
    webContents.once('destroyed', onOwnerDestroyed)
    webContents.on('did-navigate', onOwnerNavigated)

    try {
      const ptyFactory = await resolvePtyFactory(this.ptyFactory, this.nodePtySourceDir, this.nodePtyCacheDir)
      if (rendererDestroyed || webContents.isDestroyed()) {
        throw new Error('terminal renderer is destroyed')
      }

      sessionId = this.nextSessionId++
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

      if (rendererDestroyed || webContents.isDestroyed()) {
        disposePty()
        throw new Error('terminal renderer is destroyed')
      }

      const activeSessionId = sessionId
      const activePty = pty
      this.sessions.set(activeSessionId, {
        pty: activePty,
        owner: webContents,
        onOwnerDestroyed,
        onOwnerNavigated,
      })

      activePty.onData(data => {
        if (this.sessions.get(activeSessionId)?.pty !== activePty) return
        sendTerminalEvent(webContents, ELECTRON_EVENT_CHANNELS.terminalOutput, {
          session_id: activeSessionId,
          data,
        } satisfies TerminalOutputPayload)
      })

      activePty.onExit(({ exitCode, signal }) => {
        const active = this.removeSession(activeSessionId, activePty)
        if (!active) return
        sendTerminalEvent(webContents, ELECTRON_EVENT_CHANNELS.terminalExit, {
          session_id: activeSessionId,
          code: exitCode,
          signal: signal == null ? null : String(signal),
        } satisfies TerminalExitPayload)
      })

      if (rendererDestroyed || webContents.isDestroyed()) {
        const active = this.removeSession(activeSessionId, activePty)
        if (active) disposePty()
        throw new Error('terminal renderer is destroyed')
      }

      return {
        session_id: activeSessionId,
        shell,
        cwd,
      }
    } catch (error) {
      if (sessionId !== null && pty) {
        const active = this.removeSession(sessionId, pty)
        if (active) disposePty()
      }
      webContents.removeListener('destroyed', onOwnerDestroyed)
      webContents.off('did-navigate', onOwnerNavigated)
      throw error
    }
  }

  write(sessionId: number, data: string, owner: TerminalWebContentsLike): void {
    this.getSession(sessionId, owner).pty.write(data)
  }

  resize(sessionId: number, cols: number, rows: number, owner: TerminalWebContentsLike): void {
    this.getSession(sessionId, owner).pty.resize(
      Math.max(MIN_TERMINAL_COLS, Math.floor(cols)),
      Math.max(MIN_TERMINAL_ROWS, Math.floor(rows)),
    )
  }

  kill(sessionId: number, owner: TerminalWebContentsLike): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.assertSessionOwner(session, owner)
    this.stopSession(sessionId, session)
  }

  killAll(): void {
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      this.stopSession(sessionId, session)
    }
  }

  private getSession(sessionId: number, owner: TerminalWebContentsLike): TerminalSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('terminal session is not running')
    this.assertSessionOwner(session, owner)
    return session
  }

  private assertSessionOwner(session: TerminalSession, owner: TerminalWebContentsLike): void {
    if (session.owner !== owner) {
      throw new Error('terminal session is owned by another renderer')
    }
  }

  private detachOwnerListener(session: TerminalSession): void {
    session.owner.removeListener('destroyed', session.onOwnerDestroyed)
    session.owner.off('did-navigate', session.onOwnerNavigated)
  }

  private removeSession(sessionId: number, expectedPty: TerminalPtyProcess): TerminalSession | null {
    const session = this.sessions.get(sessionId)
    if (!session || session.pty !== expectedPty) return null
    this.sessions.delete(sessionId)
    this.detachOwnerListener(session)
    return session
  }

  private stopSession(sessionId: number, session: TerminalSession): void {
    if (!this.removeSession(sessionId, session.pty)) return
    session.pty.kill()
  }
}
