import { createHash, randomBytes } from 'node:crypto'
import { readFile, mkdir, access, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { buildPipInstallAttempts } from './pipInstall.js'
import { loadStoredComputerUseConfig } from './preauthorizedConfig.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../../..')

// All runtime state lives in ~/.claude/.runtime — writable in both dev and
// bundled (Tauri app) modes. The setup API (or ensureRuntimeFiles below)
// populates requirements-win.txt and win_helper.py here.
//
// This bridge is Windows-only. macOS routes every command to the signed native
// `cu-helper` daemon and `helperBridge` refuses to fall back, so the old
// `mac_helper.py` was unreachable and has been deleted along with its
// pyobjc requirements file. Keeping a dead darwin branch here invited the
// reading that Python is still a supported macOS path — it is not.
const runtimeStateRoot = path.join(getClaudeConfigHomeDir(), '.runtime')
const venvRoot = path.join(runtimeStateRoot, 'venv')
const installStampPath = path.join(runtimeStateRoot, 'requirements.sha256')

const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'
const windowsInputTag = randomBytes(4).readUInt32LE(0) || 0x43434841

/**
 * The Python-backed Computer Use components differ per platform: Windows drives
 * `win_helper.py` (needs pywin32/screeninfo), Linux drives `linux_helper.py`
 * (needs python-xlib). macOS runs the signed native `cu-helper` and must never
 * bootstrap a Python venv, so it has no Python components at all — and neither
 * does an unrecognised platform.
 *
 * Resolved as a table rather than "Linux, else Windows": the old two-way choice
 * silently handed a macOS (or unknown) host the Windows-only package set.
 */
export type PythonRuntimeComponents = { helper: string; requirements: string }

export function pythonRuntimeFor(
  platform: NodeJS.Platform,
): PythonRuntimeComponents | null {
  if (platform === 'win32') {
    return { helper: 'win_helper.py', requirements: 'requirements-win.txt' }
  }
  if (platform === 'linux') {
    return { helper: 'linux_helper.py', requirements: 'requirements-linux.txt' }
  }
  return null
}

const pythonRuntime = pythonRuntimeFor(process.platform)

// Always read from ~/.claude/.runtime/ — works in both dev and bundled mode.
const requirementsPath = path.join(runtimeStateRoot, 'requirements.txt')
// Only meaningful on Python-backed platforms; on macOS this file is never
// synced or executed (ensureBootstrapped refuses first).
const helperFileName = pythonRuntime?.helper ?? 'win_helper.py'
const helperPath = path.join(runtimeStateRoot, helperFileName)
// Runs as its own process (the helper is a stateless one-shot CLI and cannot
// own a window across actions), so it ships as a separate file. Windows-only:
// on Linux a badge would be a top-level X11 window visible in every screenshot.
const cursorBadgeFileName = 'win_cursor_badge.py'
const cursorBadgePath = path.join(runtimeStateRoot, cursorBadgeFileName)

let bootstrapPromise: Promise<void> | undefined

export function getComputerUsePythonEnv(): NodeJS.ProcessEnv | undefined {
  if (!isWindows) return undefined
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    CC_HAHA_COMPUTER_USE_INPUT_TAG: String(windowsInputTag),
  }
}

function pythonBinPath(): string {
  return isWindows
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python3')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function runOrThrow(file: string, args: string[], label: string): Promise<string> {
  const { code, stdout, stderr } = await execFileNoThrow(file, args, { useCwd: false })
  if (code !== 0) {
    throw new Error(`${label} failed with code ${code}: ${stderr || stdout || 'unknown error'}`)
  }
  return stdout
}

export async function runPipInstallWithFallback(
  baseArgs: string[],
  label: string,
  run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = args =>
    execFileNoThrow(pythonBinPath(), args, { useCwd: false }),
): Promise<void> {
  let firstFailure = ''
  for (const args of buildPipInstallAttempts(baseArgs)) {
    const { code, stdout, stderr } = await run(args)
    if (code === 0) return
    if (!firstFailure) {
      firstFailure = `${label} failed with code ${code}: ${stderr || stdout || 'unknown error'}`
    }
  }
  throw new Error(firstFailure || `${label} failed`)
}

export async function installRuntimeDependencies(
  requirementsPath: string,
  install: typeof runPipInstallWithFallback = runPipInstallWithFallback,
): Promise<void> {
  await install(['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip upgrade')
  await install(['-m', 'pip', 'install', '-r', requirementsPath], 'python dependency install')
}

/**
 * Put a `pip` inside the runtime venv.
 *
 * `-m ensurepip` is the normal route, but Debian/Ubuntu ship ensurepip in a
 * separate package (`python3.X-venv`). Without it `python3 -m venv` quietly
 * produces a pip-less venv and this step dies with "No module named ensurepip"
 * — exactly what every "install component" attempt hit on such hosts, with no
 * hint of the remedy. So fall back to any pip already on the machine (a pip can
 * install into another interpreter via `--python`); when even that is absent,
 * fail with the actual instruction rather than the raw module error.
 *
 * The dependencies are injectable so the fallback chain is testable without a
 * real broken venv.
 */
export async function bootstrapPipIntoVenv(deps: {
  python?: string
  platform?: NodeJS.Platform
  run?: (file: string, args: string[], label: string) => Promise<string>
  probe?: (file: string) => Promise<boolean>
} = {}): Promise<void> {
  const python = deps.python ?? pythonBinPath()
  const run = deps.run ?? runOrThrow
  const probe =
    deps.probe ??
    (async (file: string) => {
      const { code } = await execFileNoThrow(file, ['--version'], { useCwd: false })
      return code === 0
    })

  let ensurepipError = ''
  try {
    await run(python, ['-m', 'ensurepip', '--upgrade'], 'ensurepip')
    return
  } catch (error) {
    ensurepipError = error instanceof Error ? error.message : String(error)
  }

  for (const candidate of ['pip3', 'pip']) {
    if (!(await probe(candidate))) continue
    await run(
      candidate,
      ['--python', python, 'install', '--upgrade', 'pip'],
      `pip bootstrap via ${candidate}`,
    )
    return
  }

  const remedy =
    (deps.platform ?? process.platform) === 'win32'
      ? 'Reinstall Python with the "pip" option enabled (python.org installer), or run `python -m ensurepip`.'
      : 'Install the system Python venv/pip package (Debian/Ubuntu: sudo apt install python3-venv; Fedora/RHEL: sudo dnf install python3-pip) and retry.'
  throw new Error(
    `Could not bootstrap pip into the Computer Use venv: ${ensurepipError}. ${remedy}`,
  )
}

async function getVenvCreationPythonCommand(): Promise<string> {
  const config = await loadStoredComputerUseConfig()
  if (config.pythonPath) return config.pythonPath
  return isWindows ? 'python' : 'python3'
}

/**
 * Ensure runtime source files exist in ~/.claude/.runtime/.
 * In dev mode, copies from the project's runtime/ directory on first run.
 * In bundled mode, these must have been placed there by the settings setup API.
 */
async function ensureRuntimeFiles(): Promise<void> {
  await mkdir(runtimeStateRoot, { recursive: true })

  const devRequirements = pythonRuntime
    ? path.join(projectRoot, 'runtime', pythonRuntime.requirements)
    : null
  const devHelper = path.join(projectRoot, 'runtime', helperFileName)

  // Always sync from dev runtime/ so source changes are reflected immediately.
  // Previously this only copied when the dest was missing, causing stale files
  // to persist after source updates — breaking mouse/keyboard actions if the
  // cached copy was from an older version.
  if (devRequirements && (await pathExists(devRequirements))) {
    await writeFile(requirementsPath, await readFile(devRequirements, 'utf8'), 'utf8')
  }
  if (await pathExists(devHelper)) {
    await writeFile(helperPath, await readFile(devHelper, 'utf8'), 'utf8')
  }

  if (!isLinux) {
    const devBadge = path.join(projectRoot, 'runtime', cursorBadgeFileName)
    if (await pathExists(devBadge)) {
      await writeFile(cursorBadgePath, await readFile(devBadge, 'utf8'), 'utf8')
    }
  }
}

export async function ensureBootstrapped(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise
  bootstrapPromise = (async () => {
    // Platforms without a Python component set must never get here — macOS
    // drives the native cu-helper, and anything else is unsupported. Refuse
    // loudly rather than installing the wrong platform's packages.
    if (!pythonRuntime) {
      throw new Error(
        `Computer Use has no Python components on '${process.platform}'. macOS uses the signed native cu-helper; other platforms are unsupported.`,
      )
    }

    // Extract runtime files (requirements, helper, badge) to state dir
    await ensureRuntimeFiles()

    if (!(await pathExists(pythonBinPath()))) {
      logForDebugging('creating runtime venv at %s', { level: 'debug' })
      const pythonCmd = await getVenvCreationPythonCommand()
      await runOrThrow(pythonCmd, ['-m', 'venv', venvRoot], 'python venv creation')
    }

    const pipBin = isWindows
      ? path.join(venvRoot, 'Scripts', 'pip.exe')
      : path.join(venvRoot, 'bin', 'pip')
    if (!(await pathExists(pipBin))) {
      logForDebugging('bootstrapping pip into the runtime venv', { level: 'debug' })
      await bootstrapPipIntoVenv()
    }

    const requirements = await readFile(requirementsPath, 'utf8')
    const digest = createHash('sha256').update(requirements).digest('hex')
    let installedDigest = ''
    try {
      installedDigest = (await readFile(installStampPath, 'utf8')).trim()
    } catch {}

    if (installedDigest !== digest) {
      logForDebugging('installing python runtime dependencies', { level: 'debug' })
      await installRuntimeDependencies(requirementsPath)
      await writeFile(installStampPath, `${digest}\n`, 'utf8')
    }
  })()

  try {
    await bootstrapPromise
  } catch (error) {
    bootstrapPromise = undefined
    throw error
  }
}

export async function callPythonHelper<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  await ensureBootstrapped()
  const { code, stdout, stderr } = await execFileNoThrow(
    pythonBinPath(),
    [helperPath, command, '--payload', JSON.stringify(payload)],
    { useCwd: false, env: getComputerUsePythonEnv() },
  )

  if (code !== 0 && !stdout.trim()) {
    throw new Error(stderr || `Python helper ${command} failed with code ${code}`)
  }

  let parsed: { ok: boolean; result?: T; error?: { code?: string; message?: string } }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(stderr || stdout || `Python helper ${command} returned invalid JSON`)
  }

  if (!parsed.ok) {
    // Prefix the machine-readable code so callers can branch on it. The helper
    // reports refusals such as `user_interference` and `target_window_offscreen`
    // this way, and a bare message would flatten them into indistinguishable
    // prose — the model would then retry an action that was deliberately
    // refused. Mirrors how the macOS daemon surfaces `CUError.code`.
    const code = parsed.error?.code
    const message = parsed.error?.message || `Python helper ${command} failed`
    throw new Error(code && code !== 'runtime_error' ? `${code}: ${message}` : message)
  }

  return parsed.result as T
}

export function getRuntimePaths(): { projectRoot: string; runtimeStateRoot: string; venvRoot: string } {
  return { projectRoot, runtimeStateRoot, venvRoot }
}

/** Interpreter + script path for the Windows virtual-cursor overlay. */
export function getCursorBadgeCommand(): { python: string; script: string } {
  return { python: pythonBinPath(), script: cursorBadgePath }
}
