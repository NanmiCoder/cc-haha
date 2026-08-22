import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import treeKill from 'tree-kill'
import { changedFiles, writeDiffPatch } from '../baseline/execute'
import { applyUserStateGuard, createQualityGateSandbox } from '../sandbox'
import type { BaselineTarget, LaneResult } from '../types'

const FIXTURE = 'scripts/quality-gate/desktop-smoke/fixtures/chat-edit'
const AGENT_BROWSER_HOME = join(process.env.HOME ?? '', '.agent-browser')
const LOOPBACK_PROXY_BYPASS = '127.0.0.1,localhost,::1,[::1]'
export const DESKTOP_SMOKE_COMPOSER_SELECTOR = '[data-composer-editor]'
export const DESKTOP_SMOKE_RUN_SELECTOR = [
  'button[aria-label="Run"]',
  'button[aria-label="运行"]',
  'button[aria-label="執行"]',
  'button[aria-label="実行"]',
  'button[aria-label="실행"]',
].join(',')
const PROMPT = [
  'Run the tests in this project, fix the failing greeting implementation, and rerun the tests.',
  'Only edit src/greeting.ts. Do not edit package.json or tests.',
  'When the tests pass, briefly say done.',
].join(' ')

type DesktopSmokeStage = 'open' | 'eval' | 'reload' | 'wait' | 'session-ready' | 'screenshot' | 'fill' | 'press' | 'verify'

type DesktopSmokeFailureContext = {
  stage: DesktopSmokeStage
  sessionName: string
  browserProfileDir: string
  artifactDir: string
  browserLogPath: string
  serverLogPath: string
  viteLogPath: string
  appUrl: string
  baseUrl: string
  serverPort: number
  vitePort: number
}

export function resolveDesktopSmokeRuntimeSelection(target: BaselineTarget | undefined) {
  if (!target) return null
  if (!target.providerId && target.modelId === 'current' && target.label === 'current-runtime') {
    return null
  }
  return {
    providerId: target.providerId ?? null,
    modelId: target.modelId,
  }
}

export function resolveDesktopViteExecutable(
  rootDir: string,
  platform = process.platform,
): string | null {
  const binDir = join(rootDir, 'desktop', 'node_modules', '.bin')
  const candidates = platform === 'win32'
    ? ['vite.exe', 'vite.cmd', 'vite.bunx']
    : ['vite']

  for (const candidate of candidates) {
    const executable = join(binDir, candidate)
    if (existsSync(executable)) return executable
  }
  return null
}

export function desktopSmokeAppUrl(vitePort: number) {
  return `http://localhost:${vitePort}`
}

function mergeProxyBypass(value: string | undefined) {
  const entries = new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  for (const entry of LOOPBACK_PROXY_BYPASS.split(',')) {
    entries.add(entry)
  }
  return Array.from(entries).join(',')
}

export function buildDesktopSmokeBrowserEnv(
  sessionName: string,
  browserProfileDir: string,
  baseEnv: Record<string, string | undefined> = process.env,
) {
  const noProxy = mergeProxyBypass(baseEnv.NO_PROXY ?? baseEnv.no_proxy)
  return {
    AGENT_BROWSER_SESSION: sessionName,
    AGENT_BROWSER_PROFILE: browserProfileDir,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}

export function resolveAgentBrowserExecutable(
  resolved = Bun.which('agent-browser'),
  platform = process.platform,
  arch = process.arch,
): string | null {
  if (!resolved) return null
  if (platform !== 'win32' || !resolved.toLowerCase().endsWith('.cmd')) return resolved

  const nativeExecutable = join(
    dirname(resolved),
    'node_modules',
    'agent-browser',
    'bin',
    `agent-browser-win32-${arch}.exe`,
  )
  return existsSync(nativeExecutable) ? nativeExecutable : null
}

function collectCommandStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  const done = (async () => {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += decoder.decode(chunk.value, { stream: true })
    }
    output += decoder.decode()
    return output
  })()
  return { done, cancel: () => reader.cancel() }
}

export function agentBrowserCommand(args: string[]) {
  return [resolveAgentBrowserExecutable() ?? 'agent-browser', '--proxy-bypass', LOOPBACK_PROXY_BYPASS, ...args]
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await Bun.sleep(100)
  }
  return !isProcessAlive(pid)
}

async function killProcessTree(pid: number, signal: 'SIGTERM' | 'SIGKILL') {
  await new Promise<void>((resolve, reject) => {
    treeKill(pid, signal, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export async function cleanupAgentBrowserSession(sessionName: string, logPath: string) {
  if (!sessionName || !existsSync(AGENT_BROWSER_HOME)) return

  const metadataSuffixes = ['pid', 'sock', 'stream', 'engine', 'version']
  const pidPath = join(AGENT_BROWSER_HOME, `${sessionName}.pid`)
  if (existsSync(pidPath)) {
    const rawPid = readFileSync(pidPath, 'utf8').trim()
    const pid = Number(rawPid)
    if (Number.isInteger(pid) && pid > 0) {
      try {
        await killProcessTree(pid, 'SIGTERM')
        if (!await waitForProcessExit(pid, 1_500)) {
          await killProcessTree(pid, 'SIGKILL')
        }
        appendFileSync(logPath, `\n[quality-gate] Killed agent-browser session process tree pid=${pid}\n`)
      } catch (error) {
        appendFileSync(logPath, `\n[quality-gate] Failed to kill agent-browser session process tree pid=${pid}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }

  for (const suffix of metadataSuffixes) {
    rmSync(join(AGENT_BROWSER_HOME, `${sessionName}.${suffix}`), { force: true })
  }
}

export function cleanupBrowserProfileProcesses(browserProfileDir: string, logPath: string) {
  if (process.platform === 'win32') {
    appendFileSync(logPath, '\n[quality-gate] Skipped browser profile process cleanup on Windows\n')
    return
  }

  const proc = Bun.spawnSync(['pkill', '-9', '-f', browserProfileDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${proc.stdout ? Buffer.from(proc.stdout).toString('utf8') : ''}${proc.stderr ? Buffer.from(proc.stderr).toString('utf8') : ''}`.trim()
  if (proc.exitCode === 0) {
    appendFileSync(logPath, `\n[quality-gate] Killed browser processes for profile ${browserProfileDir}\n`)
  } else if (output) {
    appendFileSync(logPath, `\n[quality-gate] Browser profile process cleanup reported: ${output}\n`)
  }
}

function writeDesktopSmokeFailure(context: DesktopSmokeFailureContext, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const diagnostics = {
    stage: context.stage,
    message,
    sessionName: context.sessionName,
    browserProfileDir: context.browserProfileDir,
    appUrl: context.appUrl,
    baseUrl: context.baseUrl,
    serverPort: context.serverPort,
    vitePort: context.vitePort,
    logs: {
      browser: context.browserLogPath,
      server: context.serverLogPath,
      vite: context.viteLogPath,
    },
  }
  writeFileSync(join(context.artifactDir, 'desktop-smoke-failure.json'), JSON.stringify(diagnostics, null, 2) + '\n')
  return new Error(`Desktop smoke failed during ${context.stage}: ${message}. session=${context.sessionName} appUrl=${context.appUrl} profile=${context.browserProfileDir} diagnostics=${join(context.artifactDir, 'desktop-smoke-failure.json')}`)
}

async function runBrowserStep(
  stage: DesktopSmokeStage,
  args: string[],
  options: Parameters<typeof runLoggedCommand>[1],
  context: Omit<DesktopSmokeFailureContext, 'stage'>,
) {
  try {
    return await runLoggedCommand(agentBrowserCommand(args), options)
  } catch (error) {
    throw writeDesktopSmokeFailure({ ...context, stage }, error)
  }
}

export async function getPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local port')))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

export async function pipeToFile(stream: ReadableStream<Uint8Array> | null, path: string) {
  if (!stream) return
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    appendFileSync(path, Buffer.from(value))
  }
}

export async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(500)
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError})` : ''}`)
}

export async function runLoggedCommand(
  command: string[],
  options: {
    cwd: string
    logPath: string
    env?: Record<string, string>
    timeoutMs?: number
    allowFailure?: boolean
    maxLogChars?: number
  },
) {
  appendFileSync(options.logPath, `\n$ ${command.join(' ')}\n`)
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = collectCommandStream(proc.stdout)
  const stderr = collectCommandStream(proc.stderr)
  const timeout = options.timeoutMs
    ? Bun.sleep(options.timeoutMs).then(() => {
      proc.kill()
      throw new Error(`Command timed out after ${options.timeoutMs}ms: ${command.join(' ')}`)
    })
    : null

  const exitCode = timeout
    ? await Promise.race([proc.exited, timeout])
    : await proc.exited
  let captured = await Promise.race([
    Promise.all([stdout.done, stderr.done]),
    Bun.sleep(250).then(() => null),
  ])
  if (!captured) {
    await Promise.allSettled([stdout.cancel(), stderr.cancel()])
    captured = await Promise.all([stdout.done, stderr.done])
  }
  const [stdoutText, stderrText] = captured
  const output = `${stdoutText}${stderrText}`
  appendFileSync(
    options.logPath,
    options.maxLogChars && output.length > options.maxLogChars
      ? `${output.slice(0, options.maxLogChars)}\n[quality-gate] output truncated at ${options.maxLogChars} chars\n`
      : output,
  )

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${exitCode}): ${command.join(' ')}`)
  }

  return { stdout: stdoutText, stderr: stderrText, exitCode }
}

export async function stopDesktopSmokeProcess(
  proc: { pid: number; kill: () => void; exited: Promise<number> },
  label: string,
  logPath: string,
) {
  try {
    await killProcessTree(proc.pid, 'SIGTERM')
  } catch (error) {
    proc.kill()
    appendFileSync(logPath, `\n[quality-gate] ${label} tree cleanup fell back to direct kill: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  await Promise.race([proc.exited.catch(() => -1), Bun.sleep(3_000)])
}

export function removeDesktopSmokeTree(path: string) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} failed with HTTP ${response.status}: ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

async function setPermissionMode(baseUrl: string, mode: string) {
  await fetchJson<{ ok: true; mode: string }>(`${baseUrl}/api/permissions/mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
}

async function waitForVerifiedProject(
  browserEnv: Record<string, string>,
  browserLogPath: string,
  rootDir: string,
  originalDir: string,
  projectDir: string,
  artifactDir: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  let lastVerificationError = 'project verification has not run yet'
  while (Date.now() < deadline) {
    const body = await runLoggedCommand(agentBrowserCommand(['get', 'text', '#content-area']), {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 15_000,
      allowFailure: true,
      maxLogChars: 4_000,
    })
    const browserText = `${body.stdout}\n${body.stderr}`

    if (browserText.includes('CLI_START_FAILED') || browserText.includes('CLI_RESTART_FAILED')) {
      throw new Error('Desktop session reported a CLI startup failure')
    }
    if (
      browserText.includes('API Error: 429') ||
      browserText.includes('AccountQuotaExceeded') ||
      browserText.includes('TooManyRequests')
    ) {
      throw new Error('Desktop session reported provider quota/rate-limit failure')
    }
    if (browserText.includes('处理过程中发生错误') || browserText.includes('API Error:')) {
      throw new Error('Desktop session reported an API error')
    }

    try {
      await verifyProject(originalDir, projectDir, artifactDir)
      return
    } catch (error) {
      lastVerificationError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(5_000)
  }

  throw new Error(`Timed out waiting for desktop project verification: ${lastVerificationError}`)
}

export function desktopSmokeTextShowsProject(text: string, projectDir: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.includes(projectDir) || lines.includes(basename(projectDir))
}

async function waitForDesktopSmokeSessionReady(
  browserEnv: Record<string, string>,
  browserLogPath: string,
  rootDir: string,
  projectDir: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  while (Date.now() < deadline) {
    const body = await runLoggedCommand(agentBrowserCommand(['get', 'text', '#content-area']), {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 15_000,
      allowFailure: true,
      maxLogChars: 4_000,
    })
    lastText = `${body.stdout}\n${body.stderr}`
    if (desktopSmokeTextShowsProject(lastText, projectDir)) return
    await Bun.sleep(1_000)
  }
  throw new Error(`Timed out waiting for desktop smoke session to restore project "${basename(projectDir)}". Last content text: ${lastText.slice(0, 500)}`)
}

async function verifyProject(originalDir: string, projectDir: string, artifactDir: string) {
  await writeDiffPatch(originalDir, projectDir, join(artifactDir, 'diff.patch'))
  const changed = changedFiles(originalDir, projectDir).map((file) => file.replaceAll('\\', '/'))
  const unexpected = changed.filter((file) => file !== 'src/greeting.ts')
  if (unexpected.length > 0) {
    throw new Error(`desktop smoke changed unexpected files: ${unexpected.join(', ')}`)
  }
  if (!changed.includes('src/greeting.ts')) {
    throw new Error('desktop smoke did not change src/greeting.ts')
  }

  const implementation = readFileSync(join(projectDir, 'src/greeting.ts'), 'utf8')
  if (!implementation.includes('from desktop smoke!')) {
    throw new Error('desktop smoke implementation is missing the expected marker text')
  }

  const proc = Bun.spawn(['bun', 'test'], {
    cwd: projectDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  writeFileSync(join(artifactDir, 'verification.log'), `${stdout}${stderr}`)
  if (exitCode !== 0) {
    throw new Error(`desktop smoke verification failed with exit code ${exitCode}`)
  }
}

export async function executeDesktopSmoke(
  rootDir: string,
  artifactDir: string,
  resultId: string,
  resultTitle: string,
  target: BaselineTarget | undefined,
): Promise<LaneResult> {
  const started = Date.now()
  mkdirSync(artifactDir, { recursive: true })

  const serverLogPath = join(artifactDir, 'server.log')
  const viteLogPath = join(artifactDir, 'vite.log')
  const browserLogPath = join(artifactDir, 'browser.log')
  const workRoot = await mkdtemp(join(tmpdir(), 'quality-gate-desktop-smoke-'))
  const originalDir = join(workRoot, 'original')
  const projectDir = join(workRoot, 'project')
  const browserProfileDir = join(workRoot, 'browser-profile')
  cpSync(join(rootDir, FIXTURE), originalDir, { recursive: true })
  cpSync(join(rootDir, FIXTURE), projectDir, { recursive: true })

  const serverPort = await getPort()
  const vitePort = await getPort()
  const baseUrl = `http://127.0.0.1:${serverPort}`
  const appUrl = desktopSmokeAppUrl(vitePort)
  const sessionName = `quality-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const browserEnv = buildDesktopSmokeBrowserEnv(sessionName, browserProfileDir)
  const browserStepContext = {
    sessionName,
    browserProfileDir,
    artifactDir,
    browserLogPath,
    serverLogPath,
    viteLogPath,
    appUrl,
    baseUrl,
    serverPort,
    vitePort,
  }

  // The smoke drives the real server through the real UI, including a global
  // permission-mode switch to bypassPermissions. Without a sandbox that switch is
  // written into the developer's real ~/.claude/settings.json and survives any
  // interrupted run, so the server gets a throwaway config dir seeded with only the
  // provider state the run needs.
  const sandbox = createQualityGateSandbox({ label: 'desktop-smoke', seedProviders: true })
  const server = Bun.spawn(['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(serverPort)], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...sandbox.env, SERVER_PORT: String(serverPort) },
  })
  void pipeToFile(server.stdout, serverLogPath)
  void pipeToFile(server.stderr, serverLogPath)

  const viteExecutable = resolveDesktopViteExecutable(rootDir)
  if (!viteExecutable) {
    throw new Error('desktop Vite executable is missing; reinstall desktop dependencies')
  }
  const vite = Bun.spawn([viteExecutable, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: join(rootDir, 'desktop'),
    env: {
      ...process.env,
      VITE_DESKTOP_SERVER_URL: baseUrl,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  void pipeToFile(vite.stdout, viteLogPath)
  void pipeToFile(vite.stderr, viteLogPath)

  let previousPermissionMode: string | null = null
  try {
    await waitForHttp(`${baseUrl}/health`, 20_000)
    await waitForHttp(appUrl, 30_000)

    const permission = await fetchJson<{ mode: string }>(`${baseUrl}/api/permissions/mode`)
    previousPermissionMode = permission.mode
    await setPermissionMode(baseUrl, 'bypassPermissions')

    const session = await fetchJson<{ sessionId: string }>(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: projectDir }),
    })
    const runtimeSelection = resolveDesktopSmokeRuntimeSelection(target)
    writeFileSync(join(artifactDir, 'runtime-selection.json'), JSON.stringify(runtimeSelection
      ? { source: 'explicit-target', ...runtimeSelection }
      : { source: 'default-runtime' }, null, 2) + '\n')

    await runBrowserStep('open', ['open', appUrl], {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 30_000,
    }, browserStepContext)
    const browserSetup = [
      `localStorage.setItem('cc-haha-open-tabs', ${JSON.stringify(JSON.stringify({
        openTabs: [{ sessionId: session.sessionId, title: 'Desktop Smoke', type: 'session' }],
        activeTabId: session.sessionId,
      }))})`,
      runtimeSelection
        ? `localStorage.setItem('cc-haha-session-runtime', ${JSON.stringify(JSON.stringify({
          [session.sessionId]: runtimeSelection,
        }))})`
        : `localStorage.removeItem('cc-haha-session-runtime')`,
    ]
    await runBrowserStep('eval', ['eval', browserSetup.join(';')], {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 15_000,
    }, browserStepContext)
    await runBrowserStep('reload', ['reload'], {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 30_000,
    }, browserStepContext)
    await runBrowserStep('wait', ['wait', DESKTOP_SMOKE_COMPOSER_SELECTOR], {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 30_000,
    }, browserStepContext)
    await runBrowserStep('session-ready', ['get', 'text', '#content-area'], {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 15_000,
      allowFailure: true,
      maxLogChars: 4_000,
    }, browserStepContext)
    await waitForDesktopSmokeSessionReady(
      browserEnv,
      browserLogPath,
      rootDir,
      projectDir,
      30_000,
    )
    await runBrowserStep('screenshot', ['screenshot', join(artifactDir, 'initial.png')], {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 20_000,
      allowFailure: true,
    }, browserStepContext)
    await runBrowserStep('fill', ['type', DESKTOP_SMOKE_COMPOSER_SELECTOR, PROMPT], {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 20_000,
    }, browserStepContext)
    await runBrowserStep('press', ['click', DESKTOP_SMOKE_RUN_SELECTOR], {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 15_000,
    }, browserStepContext)

    await waitForVerifiedProject(
      browserEnv,
      browserLogPath,
      rootDir,
      originalDir,
      projectDir,
      artifactDir,
      360_000,
    )
    await runBrowserStep('screenshot', ['screenshot', join(artifactDir, 'final.png')], {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 20_000,
      allowFailure: true,
    }, browserStepContext)

    return applyUserStateGuard({
      id: resultId,
      title: resultTitle,
      status: 'passed' as const,
      durationMs: Date.now() - started,
      artifactDir,
    }, sandbox, artifactDir)
  } catch (error) {
    return applyUserStateGuard({
      id: resultId,
      title: resultTitle,
      status: 'failed' as const,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      artifactDir,
    }, sandbox, artifactDir)
  } finally {
    if (previousPermissionMode) {
      await setPermissionMode(baseUrl, previousPermissionMode).catch((error) => {
        appendFileSync(serverLogPath, `\n[quality-gate] Failed to restore permission mode: ${error instanceof Error ? error.message : String(error)}\n`)
      })
    }
    await runLoggedCommand(agentBrowserCommand(['close']), {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: 10_000,
      allowFailure: true,
    }).catch(() => {})
    await cleanupAgentBrowserSession(sessionName, browserLogPath)
    cleanupBrowserProfileProcesses(browserProfileDir, browserLogPath)
    removeDesktopSmokeTree(browserProfileDir)
    appendFileSync(browserLogPath, `\n[quality-gate] Removed browser profile ${browserProfileDir}\n`)
    await Promise.all([
      stopDesktopSmokeProcess(server, 'server', serverLogPath),
      stopDesktopSmokeProcess(vite, 'Vite', viteLogPath),
    ])
    removeDesktopSmokeTree(workRoot)
    sandbox.cleanup()
  }
}
