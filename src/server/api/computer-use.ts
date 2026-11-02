/**
 * Computer Use API — native runtime status and feature-wide authorization.
 */

import { homedir } from 'os'
import { join } from 'path'
import { diagnosticsService } from '../services/diagnosticsService.js'
import { normalizeIconSize, readAppIconPng } from '../services/macAppIcon.js'
import { listInstalledMacApps } from './macInstalledApps.js'
import { isPythonVersionAtLeast } from './computer-use-python.js'
import { getAgentDesktopStatus, type AgentDesktopStatus } from '../../utils/computerUse/agentDesktopBridge.js'
import { buildPipInstallAttempts } from '../../utils/computerUse/pipInstall.js'
import {
  getComputerUseConfigPath,
  loadStoredComputerUseConfigResult,
  normalizePythonPath,
  saveStoredComputerUseConfig,
} from '../../utils/computerUse/preauthorizedConfig.js'
import {
  callCuHelper,
  isMacosComputerUseRuntimeSupported,
  resolveLaunchableCuHelperBinary,
} from '../../utils/computerUse/cuHelperBridge.js'
const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const runtimeStateRoot = join(claudeHome, '.runtime')
const venvRoot = join(runtimeStateRoot, 'venv')
const MIN_PYTHON_MAJOR = 3
const MIN_PYTHON_MINOR = 9
export const MIN_MACOS_COMPUTER_USE_VERSION = '14.4'

const isWindows = process.platform === 'win32'

function getPythonCommandEnv(): Record<string, string> | undefined {
  if (!isWindows) return undefined
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  } as Record<string, string>
}

async function runCommand(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: getPythonCommandEnv(),
      windowsHide: true,
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code }
  } catch {
    return { ok: false, stdout: '', stderr: `Failed to run ${cmd}`, code: -1 }
  }
}

export async function runPipInstallWithFallback(
  pythonCmd: string,
  baseArgs: string[],
  run: typeof runCommand = runCommand,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  let firstFailure: { ok: boolean; stdout: string; stderr: string; code: number } | null = null
  for (const args of buildPipInstallAttempts(baseArgs)) {
    const result = await run(pythonCmd, args)
    if (result.ok) return result
    firstFailure ??= result
  }
  return firstFailure ?? { ok: false, stdout: '', stderr: 'pip install failed', code: -1 }
}

type EnvStatus = {
  platform: string
  supported: boolean
  engine: 'macos-native' | 'agent-desktop' | 'unsupported'
  runtime?: 'agent-desktop'
  agentDesktop?: AgentDesktopStatus
  systemVersion: string | null
  arch: string
  /** macOS helper eligibility and installation, separate from OS permissions. */
  cuHelper: {
    available: boolean
    supported: boolean
    minimumMacosVersion: typeof MIN_MACOS_COMPUTER_USE_VERSION
    reason:
      | 'unsupported_platform'
      | 'system_version_unknown'
      | 'os_too_old'
      | 'helper_missing'
      | null
  }
  python: {
    installed: boolean
    version: string | null
    path: string | null
    source: 'custom' | 'system' | 'venv' | null
    error: string | null
  }
  venv: {
    created: boolean
    path: string
  }
  dependencies: {
    installed: boolean
    requirementsFound: boolean
  }
  permissions: {
    accessibility: boolean | null
    screenRecording: boolean | null
    error: string | null
  }
}

type ComputerUseCapability = Pick<EnvStatus, 'supported' | 'engine'> & {
  cuHelper: EnvStatus['cuHelper']
}

export function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string) => value.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  })
  const actual = parse(version)
  const floor = parse(minimum)
  const length = Math.max(actual.length, floor.length)
  for (let index = 0; index < length; index += 1) {
    const left = actual[index] ?? 0
    const right = floor[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}

/**
 * Choose the implementation from platform/OS eligibility first. A missing
 * native helper is a runtime failure on the native path, never a reason to
 * fall back to the obsolete macOS Python page.
 */
export function resolveComputerUseCapability(
  platform: string,
  systemVersion: string | null,
  helperPresent: boolean,
  kernelVersionEligible = false,
): ComputerUseCapability {
  const baseHelper = {
    minimumMacosVersion: MIN_MACOS_COMPUTER_USE_VERSION,
  } as const
  if (platform === 'win32' || platform === 'linux') {
    return {
      supported: true,
      engine: 'agent-desktop',
      cuHelper: {
        ...baseHelper,
        available: false,
        supported: false,
        reason: 'unsupported_platform',
      },
    }
  }
  if (platform !== 'darwin') {
    return {
      supported: false,
      engine: 'unsupported',
      cuHelper: {
        ...baseHelper,
        available: false,
        supported: false,
        reason: 'unsupported_platform',
      },
    }
  }
  if (!systemVersion && !kernelVersionEligible) {
    return {
      supported: false,
      engine: 'unsupported',
      cuHelper: {
        ...baseHelper,
        available: false,
        supported: false,
        reason: 'system_version_unknown',
      },
    }
  }
  if (systemVersion && !isVersionAtLeast(systemVersion, MIN_MACOS_COMPUTER_USE_VERSION)) {
    return {
      supported: false,
      engine: 'unsupported',
      cuHelper: {
        ...baseHelper,
        available: false,
        supported: false,
        reason: 'os_too_old',
      },
    }
  }
  return {
    supported: true,
    engine: 'macos-native',
    cuHelper: {
      ...baseHelper,
      available: helperPresent,
      supported: true,
      reason: helperPresent ? null : 'helper_missing',
    },
  }
}

/**
 * macOS permission snapshot result shape from `cu-helper check_permissions`
 * (Permissions.snapshot()). Booleans only — `screenRecording` may be reported
 * as a boolean by the snapshot; we coerce anything missing to null.
 */
type CuHelperPermissions = {
  accessibility?: boolean
  screenRecording?: boolean
}

/**
 * True only on macOS AND when the native `cu-helper` can be launched from its
 * canonical installation. This also verifies/install-repairs the packaged
 * helper instead of reporting a nested app-bundle binary as healthy.
 */
function isCuHelperAvailableForServer(): boolean {
  return process.platform === 'darwin' && resolveLaunchableCuHelperBinary() !== null
}

/**
 * Read macOS Accessibility / Screen Recording status via the native engine,
 * with NO Python prerequisite. Returns nulls on any failure so the caller can
 * surface "unknown" instead of throwing.
 */
export async function checkCuHelperPermissions(
  // Injected the same way `callCuHelper` injects its own exec, so the failure
  // branch below is reachable from a test without a real helper binary.
  call: typeof callCuHelper = callCuHelper,
): Promise<{
  accessibility: boolean | null
  screenRecording: boolean | null
  error: string | null
}> {
  try {
    const result = await call<CuHelperPermissions>('check_permissions')
    return {
      accessibility: result.accessibility ?? null,
      screenRecording: result.screenRecording ?? null,
      error: null,
    }
  } catch (error) {
    // Nulls reach the settings page as a permanent "checking…" — the UI cannot
    // tell "not probed yet" from "probe failed". Swallowing the reason silently
    // once cost a long investigation to rediscover that the shipped sidecar had
    // been re-signed and the helper was answering `unauthorized_client`.
    //
    // This is an error, not a warning: the caller only gets here when the helper
    // binary IS present, so the user did nothing wrong and the check still did
    // not complete. A helper that is merely un-granted answers with `false`.
    void diagnosticsService.recordEvent({
      type: 'computer_use_permission_probe_failed',
      severity: 'error',
      summary:
        error instanceof Error
          ? error.message
          : 'cu-helper check_permissions failed',
      details: {
        command: 'check_permissions',
        // `unauthorized_client` means the process chain failed attestation —
        // usually a signing-identity mismatch somewhere in helper -> sidecar
        // -> desktop, not a missing OS grant.
        hint: 'permissions stay unknown until this call succeeds',
      },
    })
    return {
      accessibility: null,
      screenRecording: null,
      error: error instanceof Error
        ? error.message
        : 'cu-helper check_permissions failed',
    }
  }
}

/**
 * List installed macOS apps via the native engine (no Python prerequisite).
 * Mirrors the Python list_installed_apps shape but drops any icon field so the
 * picker payload stays small. Returns [] on failure.
 */
async function listInstalledAppsViaCuHelper(): Promise<
  { bundleId: string; displayName: string; path: string }[]
> {
  try {
    const apps = await callCuHelper<
      { bundleId: string; displayName: string; path: string }[]
    >('list_installed_apps')
    if (!Array.isArray(apps)) return []
    return apps.map((app) => ({
      bundleId: app.bundleId,
      displayName: app.displayName,
      path: app.path,
    }))
  } catch {
    return []
  }
}

/**
 * Spawn the native permission card (`cu-helper request-access`) and await the
 * single stdout snapshot line the card prints when the user closes it
 * (PermissionCard.swift windowWillClose -> `{ok:true,result:{accessibility,
 * screenRecording}}`). Unlike the fire-and-forget nativePermissionCard.ts in
 * the CLI process, the settings page WANTS the post-close snapshot, so we read
 * stdout here. Resolves only when the window closes (hence the caller uses a
 * long client timeout). Returns nulls off macOS / when the binary is missing.
 */
async function openNativePermissionCard(): Promise<{
  ok: boolean
  reason?: string
  accessibility: boolean | null
  screenRecording: boolean | null
}> {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported', accessibility: null, screenRecording: null }
  }
  // Launch from the standalone-installed helper so the card drags the same `.app`
  // the daemon runs from (its own Screen Recording subject). See cuHelperInstall.ts.
  const bin = resolveLaunchableCuHelperBinary()
  if (!bin) {
    return { ok: false, reason: 'helper-missing', accessibility: null, screenRecording: null }
  }

  // `request-access` is its OWN process mode (not a `--payload` CLI command):
  // it owns an NSApplication run loop and blocks until the card window closes,
  // then prints exactly one `{ok,result}` line. runCommand spawns + reads
  // stdout + awaits exit, which is exactly what we need.
  const result = await runCommand(bin, ['request-access'])
  return resolvePermissionCardCommandResult(result)
}

export function resolvePermissionCardCommandResult(result: {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}): {
  ok: boolean
  reason?: string
  accessibility: boolean | null
  screenRecording: boolean | null
} {
  if (!result.ok) {
    return {
      ok: false,
      reason: result.stderr || `permission card exited with code ${result.code}`,
      accessibility: null,
      screenRecording: null,
    }
  }

  // Parse the final snapshot line. The card always exits 0; tolerate trailing
  // log chatter by scanning lines for the last valid JSON envelope.
  const perms = parsePermissionSnapshot(result.stdout)
  if (perms.accessibility === null && perms.screenRecording === null) {
    return {
      ok: false,
      reason: 'permission card returned no permission snapshot',
      accessibility: null,
      screenRecording: null,
    }
  }
  return { ok: true, accessibility: perms.accessibility, screenRecording: perms.screenRecording }
}

/**
 * Extract `{accessibility, screenRecording}` from the cu-helper card's stdout.
 * Scans from the LAST line backwards for a parseable `{ok,result}` envelope so
 * any incidental earlier output is ignored. Returns nulls when none is found.
 */
export function parsePermissionSnapshot(stdout: string): {
  accessibility: boolean | null
  screenRecording: boolean | null
} {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as {
        ok?: boolean
        result?: CuHelperPermissions
      }
      if (parsed.ok && parsed.result) {
        return {
          accessibility: parsed.result.accessibility ?? null,
          screenRecording: parsed.result.screenRecording ?? null,
        }
      }
    } catch {
      // not JSON — keep scanning earlier lines
    }
  }
  return { accessibility: null, screenRecording: null }
}

async function detectMacosProductVersion(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const result = await runCommand('/usr/bin/sw_vers', ['-productVersion'])
  return result.ok && result.stdout ? result.stdout : null
}

type CheckStatusDependencies = {
  platform?: string
  arch?: string
  detectMacosProductVersion?: () => Promise<string | null>
  isMacosRuntimeSupported?: (platform: string) => boolean
  isCuHelperAvailable?: () => boolean
  checkPermissions?: typeof checkCuHelperPermissions
  getAgentDesktopStatus?: typeof getAgentDesktopStatus
}

export async function checkStatus(
  dependencies: CheckStatusDependencies = {},
): Promise<EnvStatus> {
  const platform = dependencies.platform ?? process.platform
  const arch = dependencies.arch ?? process.arch
  const systemVersion = platform === 'darwin'
    ? await (dependencies.detectMacosProductVersion ?? detectMacosProductVersion)()
    : null
  const kernelVersionEligible = platform === 'darwin'
    && (dependencies.isMacosRuntimeSupported ?? isMacosComputerUseRuntimeSupported)(platform)
  const macosEligible = platform === 'darwin'
    && (systemVersion !== null
      ? isVersionAtLeast(systemVersion, MIN_MACOS_COMPUTER_USE_VERSION)
      : kernelVersionEligible)
  const helperPresent = macosEligible
    && (dependencies.isCuHelperAvailable ?? isCuHelperAvailableForServer)()
  const capability = resolveComputerUseCapability(
    platform,
    systemVersion,
    helperPresent,
    kernelVersionEligible,
  )
  const supported = capability.supported

  // macOS has a self-contained native runtime. Its status must never wait for
  // a stale custom Python executable or expose the retired setup flow.
  if (platform === 'darwin') {
    const permissions = capability.cuHelper.available
      ? await (dependencies.checkPermissions ?? checkCuHelperPermissions)()
      : { accessibility: null, screenRecording: null, error: null }
    return {
      platform,
      supported,
      engine: capability.engine,
      systemVersion,
      arch,
      cuHelper: capability.cuHelper,
      python: { installed: false, version: null, path: null, source: null, error: null },
      venv: { created: false, path: venvRoot },
      dependencies: { installed: false, requirementsFound: false },
      permissions,
    }
  }

  const agentDesktop = platform === 'win32' || platform === 'linux'
    ? await (dependencies.getAgentDesktopStatus ?? getAgentDesktopStatus)({ platform })
    : undefined
  return {
    platform,
    supported,
    engine: capability.engine,
    ...(agentDesktop ? { runtime: 'agent-desktop' as const, agentDesktop } : {}),
    systemVersion,
    arch,
    cuHelper: capability.cuHelper,
    python: { installed: false, version: null, path: null, source: null, error: null },
    venv: { created: false, path: venvRoot },
    dependencies: { installed: false, requirementsFound: false },
    permissions: { accessibility: null, screenRecording: null, error: null },
  }
}

type SetupResult = {
  success: boolean
  steps: { name: string; ok: boolean; message: string }[]
}

export function getUnsupportedComputerUsePlatformStep(
  platform: string,
): SetupResult['steps'][number] | null {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return null
  return {
    name: 'platform',
    ok: false,
    message: `Computer Use does not support platform: ${platform}`,
  }
}

export function getUnsupportedPythonVersionStep(
  version: string | null,
): SetupResult['steps'][number] | null {
  if (isPythonVersionAtLeast(version, MIN_PYTHON_MAJOR, MIN_PYTHON_MINOR)) return null
  return {
    name: 'python_version',
    ok: false,
    message: `Computer Use 需要 Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}，当前版本为 ${version ?? 'unknown'}`,
  }
}

export async function installSetupDependencies(
  venvPython: string,
  reqPath: string,
  install: typeof runPipInstallWithFallback = runPipInstallWithFallback,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  await install(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])
  return install(venvPython, ['-m', 'pip', 'install', '-r', reqPath])
}

export async function runSetup(platform: string = process.platform): Promise<SetupResult> {
  const unsupported = getUnsupportedComputerUsePlatformStep(platform)
  return {
    success: false,
    steps: [unsupported ?? {
      name: 'native_runtime',
      ok: false,
      message: 'Computer Use uses the bundled native runtime. Python setup is no longer required. Reinstall the app if the runtime is missing; source builds must build the native helper.',
    }],
  }
}

// ============================================================================
// Authorized Apps configuration — stored in ~/.claude/cc-haha/computer-use-config.json
// ============================================================================

type AuthorizedApp = {
  bundleId: string
  displayName: string
  authorizedAt?: string
  [key: string]: unknown
}

type ComputerUseConfig = {
  enabled: boolean
  authorizedApps: AuthorizedApp[]
  grantFlags: {
    clipboardRead: boolean
    clipboardWrite: boolean
    systemKeyCombos: boolean
  }
  pythonPath: string | null
}

export type ComputerUseConfigPatch = {
  enabled?: boolean
  authorizedApps?: AuthorizedApp[]
  grantFlags?: Partial<ComputerUseConfig['grantFlags']>
  pythonPath?: string | null
}

async function saveConfig(config: ComputerUseConfig): Promise<void> {
  await saveStoredComputerUseConfig(config)
  // Deliberately no cache invalidation here. This runs in the SERVER process;
  // the `computer-use` skill's gate and the memoized command list both live in
  // the CLI child process, so clearing anything from here reaches nothing.
  // The CLI picks the change up by watching this file — see skillChangeDetector.
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const CONFIG_PATCH_KEYS = new Set([
  'enabled',
  'authorizedApps',
  'grantFlags',
  'pythonPath',
])
const GRANT_FLAG_KEYS = new Set([
  'clipboardRead',
  'clipboardWrite',
  'systemKeyCombos',
])
export function parseComputerUseConfigPatch(
  value: unknown,
): ComputerUseConfigPatch | null {
  if (!isPlainObject(value)) return null
  if (Object.keys(value).some(key => !CONFIG_PATCH_KEYS.has(key))) return null
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return null

  let authorizedApps: AuthorizedApp[] | undefined
  if (value.authorizedApps !== undefined) {
    if (!Array.isArray(value.authorizedApps)) return null
    authorizedApps = []
    for (const candidate of value.authorizedApps) {
      if (!isPlainObject(candidate)) return null
      if (
        typeof candidate.bundleId !== 'string'
        || typeof candidate.displayName !== 'string'
      ) {
        return null
      }
      const bundleId = candidate.bundleId.trim()
      const displayName = candidate.displayName.trim()
      if (!bundleId || !displayName) return null
      if (
        candidate.authorizedAt !== undefined
        && typeof candidate.authorizedAt !== 'string'
      ) {
        return null
      }
      authorizedApps.push({
        ...candidate,
        bundleId,
        displayName,
      })
    }
  }

  let grantFlags: ComputerUseConfigPatch['grantFlags']
  if (value.grantFlags !== undefined) {
    if (
      !isPlainObject(value.grantFlags)
      || Object.keys(value.grantFlags).some(key => !GRANT_FLAG_KEYS.has(key))
    ) {
      return null
    }
    grantFlags = {}
    for (const key of GRANT_FLAG_KEYS) {
      const flag = value.grantFlags[key]
      if (flag !== undefined && typeof flag !== 'boolean') return null
      if (typeof flag === 'boolean') grantFlags[key] = flag
    }
  }

  if (
    value.pythonPath !== undefined
    && value.pythonPath !== null
    && (
      typeof value.pythonPath !== 'string'
    )
  ) {
    return null
  }

  return {
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(authorizedApps === undefined ? {} : { authorizedApps }),
    ...(grantFlags === undefined ? {} : { grantFlags }),
    ...(value.pythonPath === undefined
      ? {}
      : { pythonPath: normalizePythonPath(value.pythonPath) }),
  }
}

export async function openComputerUseSettings(
  platform: string,
  pane: 'Privacy_ScreenCapture' | 'Privacy_Accessibility',
  run: typeof runCommand = runCommand,
): Promise<{ ok: boolean; message?: string }> {
  const command = platform === 'darwin'
    ? {
        cmd: 'open',
        args: [`x-apple.systempreferences:com.apple.preference.security?${pane}`],
      }
    : platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'start', 'ms-settings:privacy'] }
      : null
  if (!command) return { ok: false, message: 'Unsupported platform' }

  const result = await run(command.cmd, command.args)
  return result.ok
    ? { ok: true }
    : { ok: false, message: result.stderr || `Failed to run ${command.cmd}` }
}

async function listInstalledApps(): Promise<{ bundleId: string; displayName: string; path: string }[]> {
  // macOS: enumerate the application roots directly. This needs neither a
  // Python venv nor a running helper, so the app picker populates on a cold
  // install — before Computer Use has ever been granted anything.
  if (process.platform === 'darwin') {
    const apps = await listInstalledMacApps()
    if (apps.length > 0) return apps
    // The native helper is the only macOS fallback. Never cross into the
    // retired Python runtime when native app enumeration is temporarily empty.
    if (isCuHelperAvailableForServer()) return listInstalledAppsViaCuHelper()
    return []
  }

  // The legacy per-app picker has no native Windows/Linux contract. It must
  // not resurrect the retired Python runtime merely to populate an unused list.
  return []
}

/**
 * Map a bundle id to its installed bundle path.
 *
 * Enumerating applications walks several directory trees, and the picker asks
 * for one icon per visible row, so the mapping is cached briefly. The window is
 * short enough that an app installed while the picker is open still appears on
 * the next open, and long enough that a scroll through hundreds of rows scans
 * once rather than once per row.
 */
const APP_PATH_CACHE_TTL_MS = 30_000
let appPathCache: { at: number; byBundleId: Map<string, string> } | null = null
let appPathScan: Promise<Map<string, string>> | null = null

export async function resolveInstalledAppPath(
  bundleId: string,
  // Injected so a test can count scans without walking the real disk.
  lister: () => Promise<{ bundleId: string; path: string }[]> = listInstalledApps,
): Promise<string | null> {
  const cached = appPathCache
  if (cached && Date.now() - cached.at <= APP_PATH_CACHE_TTL_MS) {
    return cached.byBundleId.get(bundleId) ?? null
  }

  // Share one scan across concurrent callers. Opening the picker fires an icon
  // request per visible row at once, and a plain check-then-fill cache is still
  // cold for all of them — each would launch its own enumeration of every
  // application root.
  if (!appPathScan) {
    appPathScan = (async () => {
      try {
        const apps = await lister()
        const byBundleId = new Map(apps.map(app => [app.bundleId, app.path]))
        appPathCache = { at: Date.now(), byBundleId }
        return byBundleId
      } finally {
        appPathScan = null
      }
    })()
  }

  return (await appPathScan).get(bundleId) ?? null
}

/** Test hook: forget the bundle-id mapping between cases. */
export function __resetInstalledAppPathCacheForTests(): void {
  appPathCache = null
  appPathScan = null
}

// ============================================================================
// Route handler
// ============================================================================

export async function handleComputerUseApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  const action = segments[2]

  if (action === 'status' && req.method === 'GET') {
    const status = await checkStatus()
    return Response.json(status)
  }

  if (action === 'setup' && req.method === 'POST') {
    const result = await runSetup()
    return Response.json(result)
  }

  // GET /api/computer-use/apps — list installed macOS apps
  if (action === 'apps' && req.method === 'GET') {
    const apps = await listInstalledApps()
    return Response.json({ apps })
  }

  // GET /api/computer-use/app-icon?bundleId=…&size=… — the app's own icon.
  //
  // The parameter is a bundle id, never a path: the server resolves it against
  // the installed-app enumeration, so a caller cannot name an arbitrary file
  // and have it rasterised and returned.
  if (action === 'app-icon' && req.method === 'GET') {
    if (process.platform !== 'darwin') {
      return new Response('Not found', { status: 404 })
    }
    const bundleId = url.searchParams.get('bundleId')?.trim()
    if (!bundleId) {
      return Response.json({ error: 'bundleId is required' }, { status: 400 })
    }

    const appPath = await resolveInstalledAppPath(bundleId)
    if (!appPath) return new Response('Not found', { status: 404 })

    const size = normalizeIconSize(url.searchParams.get('size'))
    const png = await readAppIconPng(appPath, size)
    // A bundle with no icon is an ordinary outcome, not a failure — the row
    // renders its letter placeholder when this 404s.
    if (!png) return new Response('Not found', { status: 404 })

    return new Response(png as unknown as BodyInit, {
      headers: {
        'Content-Type': 'image/png',
        // Icons change only when an app is reinstalled; the server keeps its
        // own cache too, this just stops the picker refetching while scrolling.
        'Cache-Control': 'private, max-age=3600',
      },
    })
  }

  // GET /api/computer-use/authorized-apps — current authorized app config
  if (action === 'authorized-apps' && req.method === 'GET') {
    const result = await loadStoredComputerUseConfigResult()
    if (result.error) {
      const configPath = getComputerUseConfigPath()
      return Response.json(
        {
          error: 'COMPUTER_USE_CONFIG_INVALID',
          message: `Computer Use config could not be loaded: ${result.error}`,
          configPath,
          recoveryHint: '删除或修复该文件即可恢复',
        },
        { status: 500 },
      )
    }
    return Response.json(result.config)
  }

  // PUT /api/computer-use/authorized-apps — update authorized apps
  if (action === 'authorized-apps' && req.method === 'PUT') {
    let body: ComputerUseConfigPatch | null = null
    try {
      body = parseComputerUseConfigPatch(await req.json())
    } catch {}
    if (!body) {
      return Response.json(
        { error: 'INVALID_COMPUTER_USE_CONFIG', message: 'Invalid Computer Use config' },
        { status: 400 },
      )
    }
    const stored = await loadStoredComputerUseConfigResult()
    if (stored.error) {
      const configPath = getComputerUseConfigPath()
      return Response.json(
        {
          error: 'COMPUTER_USE_CONFIG_INVALID',
          message: `Computer Use config must be repaired before it can be changed: ${stored.error}`,
          configPath,
          recoveryHint: '删除或修复该文件即可恢复',
        },
        { status: 409 },
      )
    }
    const config = stored.config
    if (body.enabled !== undefined) config.enabled = body.enabled
    if (body.authorizedApps !== undefined) config.authorizedApps = body.authorizedApps
    if (body.grantFlags !== undefined) {
      config.grantFlags = { ...config.grantFlags, ...body.grantFlags }
    }
    if ('pythonPath' in body) config.pythonPath = body.pythonPath ?? null
    try {
      await saveConfig(config)
      return Response.json({ ok: true })
    } catch {
      return Response.json(
        { error: 'COMPUTER_USE_CONFIG_WRITE_FAILED', message: 'Could not save Computer Use config' },
        { status: 500 },
      )
    }
  }

  // POST /api/computer-use/open-settings — open system settings pane
  if (action === 'open-settings' && req.method === 'POST') {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return Response.json(
        { error: 'INVALID_OPEN_SETTINGS_REQUEST', message: 'Invalid settings request' },
        { status: 400 },
      )
    }
    if (!isPlainObject(body)) {
      return Response.json(
        { error: 'INVALID_OPEN_SETTINGS_REQUEST', message: 'Invalid settings request' },
        { status: 400 },
      )
    }
    const pane = body.pane ?? 'Privacy_ScreenCapture'
    const allowed = ['Privacy_ScreenCapture', 'Privacy_Accessibility']
    if (typeof pane !== 'string' || !allowed.includes(pane)) {
      return Response.json({ error: 'Invalid pane' }, { status: 400 })
    }

    const result = await openComputerUseSettings(
      process.platform,
      pane as 'Privacy_ScreenCapture' | 'Privacy_Accessibility',
    )
    if (!result.ok) {
      const supportedPlatform = process.platform === 'darwin' || process.platform === 'win32'
      return Response.json(
        {
          error: supportedPlatform ? 'OPEN_SETTINGS_FAILED' : 'UNSUPPORTED_PLATFORM',
          message: supportedPlatform
            ? 'Could not open system settings'
            : 'Computer Use is not supported on this platform',
        },
        { status: supportedPlatform ? 500 : 400 },
      )
    }
    return Response.json({ ok: true })
  }

  // POST /api/computer-use/permission-card (alias: open-permission-card)
  // macOS only: pop the native cu-helper authorization card and await its
  // post-close snapshot. The promise resolves only when the user CLOSES the
  // card, so the client uses a long timeout. No-op { ok:false, reason } off
  // darwin or when the binary is missing.
  if (
    (action === 'permission-card' || action === 'open-permission-card') &&
    req.method === 'POST'
  ) {
    const result = await openNativePermissionCard()
    return Response.json(result)
  }

  if (action === 'request-access' && req.method === 'POST') {
    return Response.json(
      {
        error: 'APP_AUTHORIZATION_REMOVED',
        message: 'Per-application Computer Use authorization is no longer required.',
      },
      { status: 410 },
    )
  }

  return Response.json(
    { error: 'NOT_FOUND', message: `Unknown computer-use action: ${action}` },
    { status: 404 },
  )
}
