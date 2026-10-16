import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyUserStateGuard, createQualityGateSandbox } from '../sandbox'
import type { LaneResult } from '../types'
import { loadCassette } from '../replay/cassette'
import { placeholderTable } from '../replay/lane'
import { startReplayServer } from '../replay/replayServer'
import { DESKTOP_REPLAY_CONTENT, DESKTOP_REPLAY_FILE, DESKTOP_REPLAY_PROMPT, DESKTOP_REPLAY_SCENARIO_ID } from '../replay/scenarios'
import { buildDesktopUiSmokeBootstrap, describeDesktopUiSmokePrerequisites, DESKTOP_UI_SMOKE_ALLOW_SELECTOR } from './deterministic'
import {
  agentBrowserCommand,
  buildDesktopSmokeBrowserEnv,
  cleanupAgentBrowserSession,
  cleanupBrowserProfileProcesses,
  DESKTOP_SMOKE_COMPOSER_SELECTOR,
  DESKTOP_SMOKE_RUN_SELECTOR,
  desktopSmokeAppUrl,
  getPort,
  pipeToFile,
  removeDesktopSmokeTree,
  resolveDesktopViteExecutable,
  runLoggedCommand,
  stopDesktopSmokeProcess,
  waitForHttp,
} from './execute'

/**
 * Desktop UI against recorded model traffic.
 *
 * The deterministic smoke drives the real UI against a mock CLI, so the UI only
 * ever renders frames the mock was written to emit. Here the real CLI runs and
 * the provider is the replay server serving a DeepSeek recording, so the UI
 * renders what a real model's stream turns into after the CLI and server: the
 * real permission request for a real Write call, then the reply after it.
 */

const FIXTURE = 'scripts/quality-gate/agent-flow/fixtures/workspace'
const REPLAY_PROVIDER_ID = 'desktop-replay-provider'

export async function executeReplayDesktopSmoke(rootDir: string, artifactDir: string): Promise<LaneResult> {
  const resultId = 'desktop-ui-replay'
  const resultTitle = 'Desktop UI against recorded DeepSeek traffic'
  const started = Date.now()
  mkdirSync(artifactDir, { recursive: true })
  const missing = describeDesktopUiSmokePrerequisites(rootDir)
  if (missing) return { id: resultId, title: resultTitle, status: 'skipped', durationMs: Date.now() - started, skipReason: missing, artifactDir }
  const cassette = loadCassette(DESKTOP_REPLAY_SCENARIO_ID)
  if (!cassette) throw new Error(`missing cassette ${DESKTOP_REPLAY_SCENARIO_ID}`)

  const serverLogPath = join(artifactDir, 'server.log')
  const viteLogPath = join(artifactDir, 'vite.log')
  const browserLogPath = join(artifactDir, 'browser.log')
  const workRoot = await mkdtemp(join(tmpdir(), 'quality-gate-desktop-replay-'))
  const projectDir = join(workRoot, 'project')
  const browserProfileDir = join(workRoot, 'browser-profile')
  cpSync(join(rootDir, FIXTURE), projectDir, { recursive: true })

  const replay = startReplayServer({ format: cassette.format })
  const serverPort = await getPort()
  const vitePort = await getPort()
  const baseUrl = `http://127.0.0.1:${serverPort}`
  const appUrl = desktopSmokeAppUrl(vitePort)
  const sessionName = `quality-gate-replay-${serverPort}-${vitePort}`
  const browserEnv = buildDesktopSmokeBrowserEnv(sessionName, browserProfileDir)

  // No CLAUDE_CLI_PATH: this lane runs the real CLI.
  const sandbox = createQualityGateSandbox({
    label: 'desktop-ui-replay',
    seedProviders: false,
    envOverrides: { CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1', CI: '' },
  })
  mkdirSync(join(sandbox.configDir, 'cc-haha'), { recursive: true })
  writeFileSync(join(sandbox.configDir, 'cc-haha', 'providers.json'), `${JSON.stringify({
    activeId: REPLAY_PROVIDER_ID,
    providers: [{ ...cassette.providerConfig, id: REPLAY_PROVIDER_ID, name: 'Replay (isolated)', apiKey: 'replay-fake-key', baseUrl: replay.url }],
  }, null, 2)}\n`)

  const server = Bun.spawn(['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(serverPort)], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...sandbox.env, SERVER_PORT: String(serverPort) },
  })
  void pipeToFile(server.stdout, serverLogPath)
  void pipeToFile(server.stderr, serverLogPath)
  const vite = Bun.spawn([resolveDesktopViteExecutable(rootDir)!, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: join(rootDir, 'desktop'),
    env: { ...process.env, VITE_DESKTOP_SERVER_URL: baseUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  void pipeToFile(vite.stdout, viteLogPath)
  void pipeToFile(vite.stderr, viteLogPath)

  const browserStep = (args: string[], options: { timeoutMs?: number; allowFailure?: boolean } = {}) =>
    runLoggedCommand(agentBrowserCommand(args), {
      cwd: rootDir,
      env: browserEnv,
      logPath: browserLogPath,
      timeoutMs: options.timeoutMs ?? 30_000,
      allowFailure: options.allowFailure,
      maxLogChars: 8_000,
    })
  const bodyText = async () => {
    const probe = await browserStep(['get', 'text', 'body'], { timeoutMs: 15_000, allowFailure: true })
    return `${probe.stdout}${probe.stderr}`
  }
  const until = async (check: () => Promise<boolean> | boolean, label: string, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await check()) return
      await Bun.sleep(500)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  const target = join(projectDir, DESKTOP_REPLAY_FILE)
  const sessionIds: string[] = []
  try {
    await waitForHttp(`${baseUrl}/health`, 30_000)
    await waitForHttp(appUrl, 60_000)
    replay.load(cassette, () => placeholderTable({ workRoot, configDir: sandbox.configDir }, 'project', sessionIds))

    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: projectDir }),
    })
    if (!created.ok) throw new Error(`POST /api/sessions failed with HTTP ${created.status}: ${await created.text()}`)
    const { sessionId } = await created.json() as { sessionId: string }
    sessionIds.push(sessionId)

    await browserStep(['open', appUrl])
    await browserStep(['eval', buildDesktopUiSmokeBootstrap(sessionId)], { timeoutMs: 15_000 })
    await browserStep(['reload'])
    await browserStep(['wait', DESKTOP_SMOKE_COMPOSER_SELECTOR])
    await browserStep(['type', DESKTOP_SMOKE_COMPOSER_SELECTOR, DESKTOP_REPLAY_PROMPT], { timeoutMs: 20_000 })
    await browserStep(['click', DESKTOP_SMOKE_RUN_SELECTOR], { timeoutMs: 15_000 })

    // The recorded Write call has to stop at the real permission dialog.
    await until(async () => (await bodyText()).includes('Allow'), 'the permission dialog for the recorded Write call')
    if (existsSync(target)) throw new Error('the recorded Write reached disk before the permission dialog was answered')
    await browserStep(['screenshot', join(artifactDir, 'permission-dialog.png')], { allowFailure: true })
    await browserStep(['click', DESKTOP_UI_SMOKE_ALLOW_SELECTOR], { timeoutMs: 20_000 })

    await until(() => existsSync(target) && readFileSync(target, 'utf8').trim() === DESKTOP_REPLAY_CONTENT, 'the approved write to land')
    await until(async () => (await bodyText()).includes('DONE'), 'the recorded reply after the write to render')
    const rendered = await bodyText()
    writeFileSync(join(artifactDir, 'final-content.txt'), rendered)
    if (!rendered.includes(DESKTOP_REPLAY_FILE)) throw new Error(`the UI never rendered the Write call for ${DESKTOP_REPLAY_FILE}`)
    await browserStep(['screenshot', join(artifactDir, 'final.png')], { allowFailure: true })

    await Bun.sleep(300)
    const report = replay.finish()
    writeFileSync(join(artifactDir, 'replay-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    const problems = [
      ...report.mismatches.map((mismatch) => `mismatch at ${mismatch.seq ?? 'extra request'}: ${mismatch.reason}`),
      ...report.unused.map((unused) => `recorded request ${unused.seq} was never made`),
    ]
    if (problems.length > 0) throw new Error(problems.join('; '))

    return applyUserStateGuard({ id: resultId, title: resultTitle, status: 'passed' as const, durationMs: Date.now() - started, artifactDir }, sandbox, artifactDir)
  } catch (error) {
    await browserStep(['screenshot', join(artifactDir, 'failure.png')], { allowFailure: true }).catch(() => {})
    writeFileSync(join(artifactDir, 'replay-report.json'), `${JSON.stringify(replay.finish(), null, 2)}\n`)
    return applyUserStateGuard({
      id: resultId,
      title: resultTitle,
      status: 'failed' as const,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      artifactDir,
    }, sandbox, artifactDir)
  } finally {
    await browserStep(['close'], { timeoutMs: 10_000, allowFailure: true }).catch(() => {})
    await cleanupAgentBrowserSession(sessionName, browserLogPath)
    cleanupBrowserProfileProcesses(browserProfileDir, browserLogPath)
    appendFileSync(browserLogPath, `\n[quality-gate] Removed browser profile ${browserProfileDir}\n`)
    await Promise.all([
      stopDesktopSmokeProcess(server, 'server', serverLogPath),
      stopDesktopSmokeProcess(vite, 'Vite', viteLogPath),
    ])
    await replay.stop()
    removeDesktopSmokeTree(workRoot)
    sandbox.cleanup()
  }
}
