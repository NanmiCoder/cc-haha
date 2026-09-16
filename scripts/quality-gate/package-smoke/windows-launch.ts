#!/usr/bin/env bun

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const WAIT_STEP_MS = 100
const STARTUP_TIMEOUT_MS = 45_000
const SHUTDOWN_TIMEOUT_MS = 30_000

type ExitState = { code: number | null; signal: NodeJS.Signals | null }

type WindowSnapshot = {
  reason?: string
  visible?: boolean
  loading?: boolean | null
  url?: string | null
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function desktopMetadata(rootDir: string): { productName: string } {
  const parsed = JSON.parse(readFileSync(join(rootDir, 'desktop', 'package.json'), 'utf8')) as {
    build?: { productName?: string }
    productName?: string
    name?: string
  }
  return { productName: parsed.build?.productName ?? parsed.productName ?? parsed.name ?? 'app' }
}

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  const candidate = systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : ''
  return candidate && existsSync(candidate) ? candidate : 'powershell.exe'
}

function quotePowerShellLiteral(value: string): string {
  return value.replaceAll("'", "''")
}

function executablePids(executable: string): Set<number> {
  const literal = quotePowerShellLiteral(resolve(executable))
  const command = `$target=[IO.Path]::GetFullPath('${literal}'); Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $target, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`
  const result = spawnSync(powershellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`Could not inspect Windows processes: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return new Set(
    String(result.stdout ?? '')
      .split(/\r?\n/)
      .map(value => Number.parseInt(value.trim(), 10))
      .filter(value => Number.isInteger(value) && value > 0),
  )
}

function newPids(before: Set<number>, current: Set<number>): number[] {
  return [...current].filter(pid => !before.has(pid)).sort((a, b) => a - b)
}

function taskkillTree(pid: number): void {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  const taskkill = systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe'
  spawnSync(taskkill, ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

async function waitUntil(label: string, timeoutMs: number, predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, WAIT_STEP_MS))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForExit(exited: Promise<ExitState>, timeoutMs: number): Promise<ExitState> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited,
      new Promise<never>((_, rejectWait) => {
        timer = setTimeout(() => rejectWait(new Error('Packaged Electron did not exit after smoke quit signal')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function readWindowSnapshots(logPath: string): WindowSnapshot[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as WindowSnapshot]
      } catch {
        return []
      }
    })
}

function readLastPort(statePath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as { lastPort?: unknown }
    return typeof parsed.lastPort === 'number' && Number.isInteger(parsed.lastPort)
      ? parsed.lastPort
      : null
  } catch {
    return null
  }
}

async function fetchOk(url: string, timeoutMs = 1_000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    await response.body?.cancel().catch(() => undefined)
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function isPortClosed(port: number): Promise<boolean> {
  return new Promise(resolveClosed => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (closed: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolveClosed(closed)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(false))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(true))
  })
}

function captureOutput(child: ChildProcessWithoutNullStreams) {
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  return () => output
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(`[packaged-windows-smoke] skipped: Windows 10/11 only (host=${process.platform})`)
    return
  }

  const rootDir = process.cwd()
  const artifactsDir = resolve(rootDir, argValue('--artifacts-dir') ?? 'desktop/build-artifacts/electron')
  const unpackedDir = join(artifactsDir, 'win-unpacked')
  const { productName } = desktopMetadata(rootDir)
  const appExecutable = join(unpackedDir, `${productName}.exe`)
  const sidecarExecutable = join(
    unpackedDir,
    'resources',
    'app.asar.unpacked',
    'src-tauri',
    'binaries',
    'claude-sidecar-x86_64-pc-windows-msvc.exe',
  )
  for (const required of [appExecutable, sidecarExecutable]) {
    if (!existsSync(required)) throw new Error(`Missing packaged smoke executable: ${required}`)
  }

  const evidenceDir = mkdtempSync(join(tmpdir(), 'cc-haha-packaged-windows-smoke-'))
  const homeDir = join(evidenceDir, 'home')
  const configDir = join(evidenceDir, 'config')
  const electronUserDataDir = join(evidenceDir, 'electron-user-data')
  const windowLog = join(evidenceDir, 'window-smoke.jsonl')
  const screenshotPath = join(evidenceDir, 'packaged-window.png')
  const quitFile = join(evidenceDir, 'quit.signal')
  const resultPath = join(evidenceDir, 'result.json')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(electronUserDataDir, { recursive: true })

  const appPidsBefore = executablePids(appExecutable)
  const sidecarPidsBefore = executablePids(sidecarExecutable)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: join(evidenceDir, 'appdata'),
    LOCALAPPDATA: join(evidenceDir, 'localappdata'),
    CLAUDE_CONFIG_DIR: configDir,
    CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
    CC_HAHA_ELECTRON_WINDOW_SMOKE_LOG: windowLog,
    CC_HAHA_ELECTRON_WINDOW_SMOKE_SCREENSHOT: screenshotPath,
    CC_HAHA_ELECTRON_PACKAGED_SMOKE_QUIT_FILE: quitFile,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  }

  const child = spawn(appExecutable, [`--user-data-dir=${electronUserDataDir}`], {
    cwd: unpackedDir,
    env,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = captureOutput(child)
  const exited = new Promise<ExitState>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  let gracefulExit = false
  let port: number | null = null
  try {
    await waitUntil('packaged Electron window, screenshot, and loopback sidecar', STARTUP_TIMEOUT_MS, async () => {
      if (child.exitCode !== null) throw new Error(`Packaged Electron exited during startup (${child.exitCode}):\n${logs()}`)
      const snapshots = readWindowSnapshots(windowLog)
      if (snapshots.some(snapshot => snapshot.reason === 'renderer-load-failed')) {
        throw new Error('Packaged Electron reported a renderer load failure')
      }
      const finalWindow = snapshots.find(snapshot => snapshot.reason === 'after-final-show')
      if (!finalWindow?.visible) return false
      if (!existsSync(screenshotPath) || statSync(screenshotPath).size < 8) return false
      const signature = readFileSync(screenshotPath).subarray(0, 8).toString('hex')
      if (signature !== '89504e470d0a1a0a') throw new Error('Packaged smoke screenshot is not a PNG')
      port = readLastPort(join(configDir, 'desktop-server-state.json'))
      if (!port) return false
      if (!await fetchOk(`http://127.0.0.1:${port}/health`)) return false
      if (!await fetchOk(`http://127.0.0.1:${port}/api/sessions?limit=1&offset=0`)) return false
      return true
    })

    const appPidsDuring = newPids(appPidsBefore, executablePids(appExecutable))
    const sidecarPidsDuring = newPids(sidecarPidsBefore, executablePids(sidecarExecutable))
    if (appPidsDuring.length === 0) throw new Error('No packaged Electron process was observed')
    if (sidecarPidsDuring.length === 0) throw new Error('No packaged sidecar process was observed')

    writeFileSync(quitFile, 'quit\n', 'utf8')
    const exitState = await waitForExit(exited, SHUTDOWN_TIMEOUT_MS)
    gracefulExit = true
    if (exitState.code !== 0) {
      throw new Error(`Packaged Electron exited with code=${exitState.code} signal=${exitState.signal}:\n${logs()}`)
    }

    await waitUntil('packaged Electron process cleanup', SHUTDOWN_TIMEOUT_MS, () =>
      newPids(appPidsBefore, executablePids(appExecutable)).length === 0)
    await waitUntil('packaged sidecar process cleanup', SHUTDOWN_TIMEOUT_MS, () =>
      newPids(sidecarPidsBefore, executablePids(sidecarExecutable)).length === 0)
    await waitUntil('packaged loopback port shutdown', SHUTDOWN_TIMEOUT_MS, () => isPortClosed(port!))

    const snapshots = readWindowSnapshots(windowLog)
    const result = {
      platform: 'windows',
      appExecutable,
      sidecarExecutable,
      port,
      windowFinalShow: snapshots.some(snapshot => snapshot.reason === 'after-final-show' && snapshot.visible === true),
      screenshotPath,
      screenshotBytes: statSync(screenshotPath).size,
      appPidsDuring,
      sidecarPidsDuring,
      appResidualPids: newPids(appPidsBefore, executablePids(appExecutable)),
      sidecarResidualPids: newPids(sidecarPidsBefore, executablePids(sidecarExecutable)),
      loopbackClosedAfterExit: await isPortClosed(port!),
    }
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    console.log('[packaged-windows-smoke] passed')
    console.log(`[packaged-windows-smoke] evidence=${evidenceDir}`)
    console.log(`[packaged-windows-smoke] screenshot=${screenshotPath}`)
    console.log(`[packaged-windows-smoke] loopback=http://127.0.0.1:${port}`)
  } finally {
    if (!gracefulExit && child.exitCode === null && child.pid) taskkillTree(child.pid)
    // Preserve window/screenshot/result evidence outside the repository, but remove
    // test configuration and Chromium state so the smoke leaves no user-like data.
    for (const disposable of [configDir, electronUserDataDir, homeDir, env.APPDATA, env.LOCALAPPDATA]) {
      if (!disposable) continue
      try { rmSync(disposable, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch {}
    }
  }
}

await main()
