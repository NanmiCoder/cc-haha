import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { ConversationService, conversationService, type TeamWorkerStart } from './conversationService.js'
import { DesktopUiPreferencesService } from './desktopUiPreferencesService.js'
import { SessionService, sessionService as sharedSessionService } from './sessionService.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'
import { __resetWebSocketHandlerStateForTests, translateCliMessage } from '../ws/handler.js'

type LaunchCapture = { args: string[]; sessionId: string; launchCwd: string; cwd: string; transcriptPath: string }

let root: string
let mainDirectory: string
let originalEnv: NodeJS.ProcessEnv
let service: ConversationService
let bridge: ReturnType<typeof createBridge>
let capturePath: string
let worktreeDirectory: string

function createBridge(runtime: ConversationService, forwardInit = false) {
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
      message(ws, message) {
        const payload = String(message)
        runtime.handleSdkPayload(ws.data.sessionId, payload)
        if (forwardInit) {
          for (const line of payload.trim().split('\n')) {
            const frame = JSON.parse(line)
            if (frame.type === 'system' && frame.subtype === 'init') translateCliMessage(frame, ws.data.sessionId)
          }
        }
      },
      close(ws) { runtime.detachSdkConnection(ws.data.sessionId, ws) },
    },
  })
}

function sdkUrl(sessionId: string) {
  return `ws://127.0.0.1:${bridge.port}/sdk/${sessionId}?token=fixture-${sessionId}`
}

async function captures(): Promise<LaunchCapture[]> {
  return (await readFile(capturePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function additionalDirectories(capture: LaunchCapture): string[] {
  return capture.args.flatMap((argument, index) => argument === '--add-dir' ? [capture.args[index + 1]!] : [])
}

async function directories(...names: string[]): Promise<string[]> {
  const paths = names.map(name => join(root, name))
  for (const directory of paths) await mkdir(directory, { recursive: true })
  return paths
}

async function saveDirectories(value: string[]) {
  await new DesktopUiPreferencesService().updateProjectDirectories({ workDir: mainDirectory, additionalDirectories: value })
}

async function eventually(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(message)
    await Bun.sleep(20)
  }
}

beforeEach(async () => {
  originalEnv = { ...process.env }
  root = await realpath(await mkdtemp(join(tmpdir(), 'conversation-additional-directories-')))
  mainDirectory = join(root, 'main')
  worktreeDirectory = join(mainDirectory, '.claude', 'worktrees', 'fixture-branch')
  capturePath = join(root, 'launches.jsonl')
  await mkdir(worktreeDirectory, { recursive: true })
  const wrapperPath = join(root, 'mock-sdk-directory-launch.ts')
  // Keep the existing deterministic SDK protocol fixture. This wrapper records
  // what the spawned CLI actually receives and simulates its transcript/cwd
  // relocation for --worktree before that fixture sends its init frame.
  await writeFile(wrapperPath, `
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizePath } from ${JSON.stringify(new URL('../../utils/sessionStoragePortable.ts', import.meta.url).href)}
const args = process.argv.slice(2)
const argument = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const sessionId = argument('--session-id') ?? argument('--resume')
const launchCwd = process.cwd()
if (args.includes('--worktree')) process.chdir(${JSON.stringify(worktreeDirectory)})
const directory = join(process.env.CLAUDE_CONFIG_DIR, 'projects', sanitizePath(process.cwd()))
await mkdir(directory, { recursive: true })
const transcriptPath = join(directory, sessionId + '.jsonl')
await appendFile(transcriptPath, JSON.stringify({
  type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, sessionId,
  cwd: process.cwd(), timestamp: new Date().toISOString(),
  entrypoint: process.env.CC_HAHA_TRANSCRIPT_ENTRYPOINT,
  message: { role: 'assistant', content: [{ type: 'text', text: 'fixture persisted turn' }] },
}) + '\\n')
await appendFile(${JSON.stringify(capturePath)}, JSON.stringify({ args, sessionId, launchCwd, cwd: process.cwd(), transcriptPath }) + '\\n')
const send = WebSocket.prototype.send
WebSocket.prototype.send = function (data) {
  const frame = JSON.parse(String(data).trim())
  if (frame.type === 'system' && frame.subtype === 'init') frame.cwd = process.cwd()
  return send.call(this, JSON.stringify(frame) + '\\n')
}
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
  __resetWebSocketHandlerStateForTests()
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  resetSettingsCache()
  resetTerminalShellEnvironmentCacheForTests()
  await rm(root, { recursive: true, force: true })
})

test('actual first launches and resumed CLIs retain the creation snapshot when project folders change', async () => {
  const sessions = new SessionService()
  const legacy = await sessions.createSession(mainDirectory, undefined, 'acceptEdits')
  const configured = await directories('数据 files', 'backend with spaces')
  await saveDirectories(configured)
  const current = await sessions.createSession(mainDirectory, undefined, 'acceptEdits')
  await saveDirectories(await directories('later project scope'))

  await service.startSession(legacy.sessionId, mainDirectory, sdkUrl(legacy.sessionId), { permissionMode: 'acceptEdits' })
  await service.stopSessionAndWait(legacy.sessionId)
  await service.startSession(current.sessionId, mainDirectory, sdkUrl(current.sessionId), { permissionMode: 'acceptEdits' })
  await service.stopSessionAndWait(current.sessionId)
  bridge.stop(true)
  service = new ConversationService()
  bridge = createBridge(service)
  await saveDirectories([])
  await service.startSession(current.sessionId, mainDirectory, sdkUrl(current.sessionId), { permissionMode: 'acceptEdits' })

  const [oldLaunch, firstLaunch, resumedLaunch] = await captures()
  expect(additionalDirectories(oldLaunch!)).toEqual([])
  expect(firstLaunch!.args).toContain('--session-id')
  expect(firstLaunch!.args).not.toContain('--resume')
  expect(resumedLaunch!.args[resumedLaunch!.args.indexOf('--resume') + 1]).toBe(current.sessionId)
  for (const launch of [firstLaunch!, resumedLaunch!]) {
    expect(additionalDirectories(launch)).toEqual(configured)
    expect(launch.cwd).toBe(mainDirectory)
    expect(launch.args).not.toContain('--dangerously-skip-permissions')
  }
  expect((await new SessionService().getSessionLaunchInfo(current.sessionId))?.additionalDirectories).toEqual(configured)
}, 20_000)

test('actual team worker first start and restart inherit the parent snapshot rather than current project folders', async () => {
  const configured = await directories('worker 数据', 'worker source files')
  await saveDirectories(configured)
  const parent = await new SessionService().createSession(mainDirectory)
  await saveDirectories(await directories('new unrelated scope'))
  const workerId = crypto.randomUUID()
  const teamWorker: TeamWorkerStart = {
    parentSessionId: parent.sessionId, teamName: 'directory-fixture', memberId: 'reader', name: 'reader',
    systemPrompt: 'Read the approved source folders', tools: ['Read'],
  }
  await service.startSession(workerId, mainDirectory, sdkUrl(workerId), { teamWorker })
  await service.stopSessionAndWait(workerId)
  await saveDirectories([])
  await service.startSession(workerId, mainDirectory, sdkUrl(workerId), { teamWorker: { ...teamWorker, resume: true } })

  const [firstLaunch, resumedLaunch] = await captures()
  expect(firstLaunch!.args[firstLaunch!.args.indexOf('--parent-session-id') + 1]).toBe(parent.sessionId)
  expect(firstLaunch!.args[firstLaunch!.args.indexOf('--agent-id') + 1]).toBe('reader@directory-fixture')
  expect(firstLaunch!.args).toContain('--session-id')
  expect(resumedLaunch!.args[resumedLaunch!.args.indexOf('--resume') + 1]).toBe(workerId)
  expect(additionalDirectories(firstLaunch!)).toEqual(configured)
  expect(additionalDirectories(resumedLaunch!)).toEqual(configured)
}, 20_000)

test('worktree SDK init transfers the snapshot before deleting the launch placeholder and resumes the surviving transcript', async () => {
  const configured = await directories('worktree auxiliary 数据')
  await saveDirectories(configured)
  const sessions = new SessionService()
  const created = await sessions.createSession(mainDirectory)
  await sessions.appendSessionMetadata(created.sessionId, {
    workDir: mainDirectory,
    customTitle: 'Worktree collaboration title',
    repository: {
      requestedWorkDir: mainDirectory, repoRoot: mainDirectory, branch: 'main', worktree: true,
      baseRef: 'main', worktreePath: worktreeDirectory, worktreeSlug: 'fixture-branch', worktreeBranch: 'fixture-branch',
    },
  })
  const placeholder = (await sessions.getSessionLaunchInfo(created.sessionId))!.filePath
  bridge.stop(true)
  service = conversationService
  bridge = createBridge(service, true)
  await saveDirectories([])
  await service.startSession(created.sessionId, mainDirectory, sdkUrl(created.sessionId))
  await eventually(() => stat(placeholder).then(() => false, () => true), 'worktree init did not remove its launch placeholder')
  const saved = await new SessionService().getSessionLaunchInfo(created.sessionId)
  expect(saved?.filePath).toBe(join(process.env.CLAUDE_CONFIG_DIR!, 'projects', sanitizePath(worktreeDirectory), `${created.sessionId}.jsonl`))
  expect(saved?.workDir).toBe(worktreeDirectory)
  expect(saved?.additionalDirectories).toEqual(configured)
  expect(saved?.customTitle).toBe('Worktree collaboration title')
  await service.stopSessionAndWait(created.sessionId)
  await service.startSession(created.sessionId, worktreeDirectory, sdkUrl(created.sessionId))
  const [firstLaunch, resumedLaunch] = await captures()
  expect(firstLaunch!.args).toContain('--worktree')
  expect(firstLaunch!.launchCwd).toBe(mainDirectory)
  expect(resumedLaunch!.args).not.toContain('--worktree')
  expect(resumedLaunch!.args).toContain('--resume')
  expect(additionalDirectories(firstLaunch!)).toEqual(configured)
  expect(additionalDirectories(resumedLaunch!)).toEqual(configured)
  const entries = (await readFile(saved!.filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(entries).toContainEqual(expect.objectContaining({ type: 'session-meta', additionalDirectories: configured }))
  expect(entries).toContainEqual(expect.objectContaining({ type: 'custom-title', customTitle: 'Worktree collaboration title' }))
  const projects = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
  const survivors = (await Promise.all((await readdir(projects)).map(async project => {
    const candidate = join(projects, project, created.sessionId + '.jsonl')
    return await stat(candidate).then(() => candidate, () => null)
  }))).filter(Boolean)
  expect(survivors).toEqual([saved!.filePath])
}, 20_000)

test('a startup snapshot that lands after worktree init keeps the init cwd', async () => {
  const configured = await directories('late snapshot 数据')
  await saveDirectories(configured)
  const sessions = new SessionService()
  const created = await sessions.createSession(mainDirectory)
  await sessions.appendSessionMetadata(created.sessionId, {
    workDir: mainDirectory,
    repository: {
      requestedWorkDir: mainDirectory, repoRoot: mainDirectory, branch: 'main', worktree: true,
      baseRef: 'main', worktreePath: worktreeDirectory, worktreeSlug: 'fixture-branch', worktreeBranch: 'fixture-branch',
    },
  })
  const placeholder = (await sessions.getSessionLaunchInfo(created.sessionId))!.filePath
  bridge.stop(true)
  service = conversationService
  bridge = createBridge(service, true)
  // startSession resumes once the SDK socket attaches, before system/init, and
  // snapshots the launch cwd. Hold that write until init has written the
  // worktree cwd and removed the placeholder, so the snapshot lands last.
  const append = sharedSessionService.appendSessionMetadata
  sharedSessionService.appendSessionMetadata = async function (sessionId, metadata) {
    if (sessionId === created.sessionId && metadata.workDir === mainDirectory && metadata.additionalDirectories) {
      await eventually(() => stat(placeholder).then(() => false, () => true), 'worktree init did not remove its launch placeholder')
    }
    return append.call(this, sessionId, metadata)
  }
  try {
    await service.startSession(created.sessionId, mainDirectory, sdkUrl(created.sessionId))
  } finally {
    sharedSessionService.appendSessionMetadata = append
  }

  const saved = await new SessionService().getSessionLaunchInfo(created.sessionId)
  expect(saved?.workDir).toBe(worktreeDirectory)
  expect(saved?.filePath).toBe(join(process.env.CLAUDE_CONFIG_DIR!, 'projects', sanitizePath(worktreeDirectory), `${created.sessionId}.jsonl`))
  expect(saved?.additionalDirectories).toEqual(configured)
  expect(await stat(placeholder).then(() => true, () => false)).toBe(false)
}, 20_000)
