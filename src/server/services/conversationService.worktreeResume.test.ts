import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { ConversationService } from './conversationService.js'
import { SessionService } from './sessionService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

type LaunchCapture = { args: string[]; launchCwd: string }

let root: string
let repo: string
let worktree: string
let capturePath: string
let originalEnv: NodeJS.ProcessEnv
let service: ConversationService
let bridge: ReturnType<typeof createBridge>

function createBridge(runtime: ConversationService) {
  return Bun.serve<{ sessionId: string }>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const sessionId = url.pathname.split('/').pop()!
      if (!runtime.authorizeSdkConnection(sessionId, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
      return server.upgrade(request, { data: { sessionId } }) ? undefined : new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      open(ws) { runtime.attachSdkConnection(ws.data.sessionId, ws) },
      message(ws, message) { runtime.handleSdkPayload(ws.data.sessionId, String(message)) },
      close(ws) { runtime.detachSdkConnection(ws.data.sessionId, ws) },
    },
  })
}

function sdkUrl(sessionId: string) {
  return `ws://127.0.0.1:${bridge.port}/sdk/${sessionId}?token=fixture-${sessionId}`
}

async function lastLaunch(): Promise<LaunchCapture> {
  return JSON.parse((await readFile(capturePath, 'utf8')).trim().split('\n').at(-1)!)
}

/**
 * The transcript a CLI leaves after EnterWorktree: the conversation stays in
 * the project folder of `startedIn`, the worktree-state record names the
 * worktree, and system/init made the server record the worktree as workDir.
 */
async function sessionThatEnteredWorktree(startedIn: string, worktreeOriginalCwd: string): Promise<string> {
  const sessions = new SessionService()
  const { sessionId } = await sessions.createSession(startedIn)
  const transcript = (await sessions.getSessionLaunchInfo(sessionId))!.filePath
  const prompt = crypto.randomUUID()
  const base = { sessionId, version: '9.9.9', timestamp: new Date().toISOString(), isSidechain: false, userType: 'external' }
  await appendFile(transcript, [
    { ...base, type: 'user', uuid: prompt, parentUuid: null, cwd: startedIn, message: { role: 'user', content: 'enter a worktree' } },
    { type: 'worktree-state', sessionId, worktreeSession: { originalCwd: worktreeOriginalCwd, worktreePath: worktree, worktreeName: 'feature-x', worktreeBranch: 'worktree-feature-x', sessionId } },
    { ...base, type: 'assistant', uuid: crypto.randomUUID(), parentUuid: prompt, cwd: worktree, message: { role: 'assistant', content: [{ type: 'text', text: 'Working in the worktree now.' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  await sessions.appendSessionMetadata(sessionId, { workDir: worktree })
  return sessionId
}

beforeEach(async () => {
  originalEnv = { ...process.env }
  root = await realpath(await mkdtemp(join(tmpdir(), 'conversation-worktree-resume-')))
  repo = join(root, 'repo')
  worktree = join(repo, '.claude', 'worktrees', 'feature-x')
  capturePath = join(root, 'launches.jsonl')
  await mkdir(worktree, { recursive: true })
  const wrapperPath = join(root, 'mock-sdk-launch.ts')
  await writeFile(wrapperPath, `
import { appendFile } from 'node:fs/promises'
await appendFile(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), launchCwd: process.cwd() }) + '\\n')
await import(${JSON.stringify(new URL('../__tests__/fixtures/mock-sdk-cli.ts', import.meta.url).href)})
`)
  const env = createSandboxedTestEnvironment(root, {
    CLAUDE_CLI_PATH: wrapperPath,
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  resetSettingsCache()
  resetTerminalShellEnvironmentCacheForTests()
  service = new ConversationService()
  bridge = createBridge(service)
})

afterEach(async () => {
  await service.stopAllSessionsAndWait(1_000)
  bridge.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  resetSettingsCache()
  resetTerminalShellEnvironmentCacheForTests()
  await rm(root, { recursive: true, force: true })
})

test('a session that entered a worktree mid-session resumes from the folder holding its conversation', async () => {
  const sessionId = await sessionThatEnteredWorktree(repo, repo)
  const workDir = await new SessionService().getSessionWorkDir(sessionId)
  expect(workDir).toBe(worktree)

  await service.startSession(sessionId, workDir!, sdkUrl(sessionId))

  const launch = await lastLaunch()
  expect(launch.args).toContain('--resume')
  expect(launch.launchCwd).toBe(repo)
  // The running session still reports where the CLI works.
  expect(service.getSessionWorkDir(sessionId)).toBe(worktree)
}, 20_000)

test('a session started in a subdirectory resumes from that subdirectory, not the repository root', async () => {
  const subdirectory = join(repo, 'packages', 'app')
  await mkdir(subdirectory, { recursive: true })
  // EnterWorktree records the repository root it switched to before creating the worktree.
  const sessionId = await sessionThatEnteredWorktree(subdirectory, repo)

  await service.startSession(sessionId, worktree, sdkUrl(sessionId))

  expect((await lastLaunch()).launchCwd).toBe(subdirectory)
}, 20_000)

test('a session whose conversation lives in its worktree keeps resuming there', async () => {
  const sessions = new SessionService()
  const { sessionId } = await sessions.createSession(worktree)
  const transcript = (await sessions.getSessionLaunchInfo(sessionId))!.filePath
  await appendFile(transcript, JSON.stringify({
    type: 'user', uuid: crypto.randomUUID(), parentUuid: null, sessionId, cwd: worktree,
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'isolated from the start' },
  }) + '\n')

  await service.startSession(sessionId, worktree, sdkUrl(sessionId))

  const launch = await lastLaunch()
  expect(launch.args).toContain('--resume')
  expect(launch.launchCwd).toBe(worktree)
}, 20_000)
