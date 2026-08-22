import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildMockToolPrompt } from '../agent-flow/scenarios'
import { applyUserStateGuard, createQualityGateSandbox } from '../sandbox'
import type { LaneResult } from '../types'
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
  resolveAgentBrowserExecutable,
  resolveDesktopViteExecutable,
  removeDesktopSmokeTree,
  runLoggedCommand,
  stopDesktopSmokeProcess,
  waitForHttp,
} from './execute'

/**
 * Deterministic desktop UI smoke.
 *
 * The existing agent-browser smoke needs a real provider and answers permissions by
 * flipping the *global* permission mode to bypassPermissions, so the approval UI —
 * the one screen where a wrong render lets a model touch files the user did not
 * agree to — was never exercised by any automated check. This lane drives the same
 * real UI against the repository's mock SDK CLI, so it runs with no provider, no
 * credentials, and no network, and it answers the permission request by clicking
 * the real button.
 */

const FIXTURE = 'scripts/quality-gate/agent-flow/fixtures/workspace'
const MOCK_CLI = 'src/server/__tests__/fixtures/mock-sdk-cli.ts'
const TARGET_FILE = 'ui-smoke-output.txt'
const TARGET_CONTENT = 'written-through-the-desktop-ui'
const SMOKE_PROVIDER_ID = 'desktop-ui-smoke-provider'
const SMOKE_MODEL_ID = 'desktop-ui-smoke-model'

/** Locale is pinned so the approval button label is stable across contributors. */
export const DESKTOP_UI_SMOKE_LOCALE = 'en'
export const DESKTOP_UI_SMOKE_ALLOW_SELECTOR = 'button[aria-label^="Allow: "]'

export function buildDesktopUiSmokeBootstrap(sessionId: string) {
  return [
    `localStorage.setItem('cc-haha-locale', ${JSON.stringify(DESKTOP_UI_SMOKE_LOCALE)})`,
    `localStorage.setItem('cc-haha-open-tabs', ${JSON.stringify(JSON.stringify({
      openTabs: [{ sessionId, title: 'Desktop UI Smoke', type: 'session' }],
      activeTabId: sessionId,
    }))})`,
    `localStorage.removeItem('cc-haha-session-runtime')`,
  ].join(';')
}

export function buildDesktopUiSmokePrompt(projectDir: string) {
  const target = join(projectDir, TARGET_FILE)
  return {
    target,
    prompt: buildMockToolPrompt({
      tool: 'Write',
      input: { file_path: target, content: TARGET_CONTENT },
      write: { path: target, content: TARGET_CONTENT },
      reply: `wrote ${TARGET_FILE}`,
    }),
  }
}

export function seedDesktopUiSmokeProvider(configDir: string) {
  const ccHahaDir = join(configDir, 'cc-haha')
  mkdirSync(ccHahaDir, { recursive: true })
  writeFileSync(join(ccHahaDir, 'providers.json'), JSON.stringify({
    activeId: SMOKE_PROVIDER_ID,
    providers: [{
      id: SMOKE_PROVIDER_ID,
      presetId: 'custom',
      name: 'Desktop UI Smoke (isolated)',
      apiKey: 'desktop-ui-smoke-fake-key',
      baseUrl: 'http://127.0.0.1:1',
      apiFormat: 'anthropic',
      runtimeKind: 'anthropic_compatible',
      models: {
        main: SMOKE_MODEL_ID,
        haiku: SMOKE_MODEL_ID,
        sonnet: SMOKE_MODEL_ID,
        opus: SMOKE_MODEL_ID,
      },
    }],
    providerOrder: ['claude-official', 'openai-official', 'grok-official', SMOKE_PROVIDER_ID],
  }, null, 2) + '\n')
}

async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(500)
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError})` : ''}`)
}

/**
 * The lane needs the `agent-browser` binary and installed desktop dependencies.
 * Neither is required to run the rest of the deterministic gate, so a contributor
 * without them gets an explicit skip instead of a confusing failure.
 */
export function describeDesktopUiSmokePrerequisites(rootDir: string): string | null {
  if (!existsSync(join(rootDir, 'desktop', 'node_modules', '.bin'))) {
    return 'desktop dependencies are not installed (run `bun install` in desktop/)'
  }
  if (!resolveDesktopViteExecutable(rootDir)) {
    return 'desktop Vite executable is missing (reinstall desktop dependencies)'
  }
  const agentBrowserExecutable = resolveAgentBrowserExecutable()
  if (!agentBrowserExecutable) {
    return 'agent-browser is not installed (see https://github.com/anthropics/agent-browser)'
  }
  const probe = Bun.spawnSync([agentBrowserExecutable, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  if (probe.exitCode !== 0) {
    return 'agent-browser is not installed (see https://github.com/anthropics/agent-browser)'
  }
  return null
}

export async function executeDeterministicDesktopSmoke(
  rootDir: string,
  artifactDir: string,
  resultId: string,
  resultTitle: string,
): Promise<LaneResult> {
  const started = Date.now()
  mkdirSync(artifactDir, { recursive: true })

  const missing = describeDesktopUiSmokePrerequisites(rootDir)
  if (missing) {
    return {
      id: resultId,
      title: resultTitle,
      status: 'skipped',
      durationMs: Date.now() - started,
      skipReason: missing,
      artifactDir,
    }
  }

  const serverLogPath = join(artifactDir, 'server.log')
  const viteLogPath = join(artifactDir, 'vite.log')
  const browserLogPath = join(artifactDir, 'browser.log')
  const workRoot = await mkdtemp(join(tmpdir(), 'quality-gate-desktop-ui-smoke-'))
  const projectDir = join(workRoot, 'project')
  const browserProfileDir = join(workRoot, 'browser-profile')
  cpSync(join(rootDir, FIXTURE), projectDir, { recursive: true })

  const serverPort = await getPort()
  const vitePort = await getPort()
  const baseUrl = `http://127.0.0.1:${serverPort}`
  const appUrl = desktopSmokeAppUrl(vitePort)
  const sessionName = `quality-gate-ui-${serverPort}-${vitePort}`
  const browserEnv = buildDesktopSmokeBrowserEnv(sessionName, browserProfileDir)

  const sandbox = createQualityGateSandbox({
    label: 'desktop-ui-smoke',
    seedProviders: false,
    envOverrides: {
      CLAUDE_CLI_PATH: resolve(rootDir, MOCK_CLI),
      CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
    },
  })
  seedDesktopUiSmokeProvider(sandbox.configDir)

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
    throw new Error('desktop Vite executable disappeared after prerequisite checks')
  }
  const vite = Bun.spawn([viteExecutable, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
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

  const { target, prompt } = buildDesktopUiSmokePrompt(projectDir)

  try {
    await waitForHttp(`${baseUrl}/health`, 30_000)
    await waitForHttp(appUrl, 60_000)

    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: projectDir }),
    })
    if (!created.ok) {
      throw new Error(`POST /api/sessions failed with HTTP ${created.status}: ${await created.text()}`)
    }
    const session = await created.json() as { sessionId: string }

    await browserStep(['open', appUrl])
    await browserStep(['eval', buildDesktopUiSmokeBootstrap(session.sessionId)], { timeoutMs: 15_000 })
    await browserStep(['reload'])
    // The composer is a ProseMirror contenteditable (MentionComposer), not a
    // <textarea> — `[data-composer-editor]` is the attribute the editor sets on
    // its editable node and the same hook composerTestUtils drives.
    await browserStep(['wait', DESKTOP_SMOKE_COMPOSER_SELECTOR])

    // `type` drives the editor's input path so React and ProseMirror observe the
    // same update as a person typing. `fill` can replace only the DOM text while
    // leaving the editor state empty.
    await browserStep(['type', DESKTOP_SMOKE_COMPOSER_SELECTOR, prompt], { timeoutMs: 20_000 })
    // Click the visible Run control. A standalone `press Enter` command starts a
    // separate agent-browser invocation and does not reliably preserve the
    // contenteditable focus on Windows.
    await browserStep(['click', DESKTOP_SMOKE_RUN_SELECTOR], { timeoutMs: 15_000 })

    // The permission dialog is the point of this lane: nothing may touch the
    // fixture until the real button is clicked.
    await pollUntil(async () => {
      const probe = await browserStep(['get', 'text', 'body'], { timeoutMs: 15_000, allowFailure: true })
      return `${probe.stdout}${probe.stderr}`.includes('Allow')
    }, 60_000, 'the permission dialog to render')

    if (existsSync(target)) {
      throw new Error('the tool wrote the fixture file before the permission dialog was answered')
    }
    await browserStep(['screenshot', join(artifactDir, 'permission-dialog.png')], { allowFailure: true })
    await browserStep(['click', DESKTOP_UI_SMOKE_ALLOW_SELECTOR], { timeoutMs: 20_000 })

    await pollUntil(
      async () => existsSync(target) && readFileSync(target, 'utf8') === TARGET_CONTENT,
      60_000,
      'the approved tool to write the fixture file',
    )

    const finalText = await browserStep(['get', 'text', 'body'], { timeoutMs: 15_000, allowFailure: true })
    const rendered = `${finalText.stdout}${finalText.stderr}`
    writeFileSync(join(artifactDir, 'final-content.txt'), rendered)
    if (!rendered.includes(TARGET_FILE)) {
      throw new Error(`the UI never rendered the tool call for ${TARGET_FILE}`)
    }
    await browserStep(['screenshot', join(artifactDir, 'final.png')], { allowFailure: true })

    return applyUserStateGuard({
      id: resultId,
      title: resultTitle,
      status: 'passed' as const,
      durationMs: Date.now() - started,
      artifactDir,
    }, sandbox, artifactDir)
  } catch (error) {
    await browserStep(['screenshot', join(artifactDir, 'failure.png')], { allowFailure: true }).catch(() => {})
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
    removeDesktopSmokeTree(workRoot)
    sandbox.cleanup()
  }
}
