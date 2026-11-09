import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { SessionService } from './sessionService.js'
import { DesktopUiPreferencesService } from './desktopUiPreferencesService.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let root: string
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'session-worktree-race-')))
  const env = createSandboxedTestEnvironment(root)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  resetSettingsCache()
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  resetSettingsCache()
  await fs.rm(root, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('worktree cleanup waits for an in-flight metadata transfer across service instances', async () => {
  const main = join(root, 'main')
  const worktree = join(main, '.claude/worktrees/fixture')
  const extra = join(root, 'extra 数据')
  await fs.mkdir(worktree, { recursive: true })
  await fs.mkdir(extra)
  await new DesktopUiPreferencesService().updateProjectDirectories({ workDir: main, additionalDirectories: [extra] })
  const setup = new SessionService()
  const created = await setup.createSession(main)
  await setup.appendSessionMetadata(created.sessionId, {
    workDir: main, customTitle: 'Keep this collaboration title',
    repository: { requestedWorkDir: main, repoRoot: main, branch: 'main', worktree: true, baseRef: 'main', worktreePath: worktree },
  })
  const placeholder = (await setup.getSessionLaunchInfo(created.sessionId))!.filePath
  const target = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', sanitizePath(worktree), created.sessionId + '.jsonl')
  await fs.mkdir(join(target, '..'), { recursive: true })
  await fs.writeFile(target, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, sessionId: created.sessionId, cwd: worktree, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'persisted worktree turn' }] } }) + '\n')

  const startup = new SessionService() as any
  const entered = deferred()
  const release = deferred()
  const read = startup.getMetadataProjection
  let held = false
  startup.getMetadataProjection = async function (filePath: string, projectDir: string) {
    if (!held && filePath === placeholder) {
      held = true
      entered.resolve()
      await release.promise
    }
    return read.call(this, filePath, projectDir)
  }
  const write = startup.appendSessionMetadata(created.sessionId, { workDir: worktree })
  await entered.promise
  const readdir = fs.readdir
  let cleanupStarted = false
  const readdirSpy = spyOn(fs, 'readdir').mockImplementation(((...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]) === join(process.env.CLAUDE_CONFIG_DIR!, 'projects') && (args[1] as { withFileTypes?: boolean })?.withFileTypes) cleanupStarted = true
    return readdir(...args)
  }) as typeof fs.readdir)
  const cleanup = new SessionService().deletePlaceholderSessionFiles(created.sessionId, worktree)
  try {
    // Let an overlapping cleanup finish before resuming the metadata read.
    // A serialized cleanup may instead remain queued until the read is released.
    if (cleanupStarted) await cleanup
  } finally {
    release.resolve()
    startup.getMetadataProjection = read
    await Promise.allSettled([write, cleanup])
    readdirSpy.mockRestore()
  }
  await write
  expect(await cleanup).toBe(1)
  const launch = await new SessionService().getSessionLaunchInfo(created.sessionId)
  expect(launch).toMatchObject({ filePath: target, workDir: worktree, additionalDirectories: [extra], customTitle: 'Keep this collaboration title' })
  expect(await fs.stat(placeholder).then(() => true, () => false)).toBe(false)
  const projects = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
  const survivors = (await Promise.all((await fs.readdir(projects)).map(async project => {
    const candidate = join(projects, project, created.sessionId + '.jsonl')
    return await fs.stat(candidate).then(() => candidate, () => null)
  }))).filter(Boolean)
  expect(survivors).toEqual([target])
  const records = (await fs.readFile(target, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(records).toContainEqual(expect.objectContaining({ type: 'session-meta', additionalDirectories: [extra] }))
  expect(records).toContainEqual(expect.objectContaining({ type: 'custom-title', customTitle: 'Keep this collaboration title' }))
  expect(records).toContainEqual(expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [{ type: 'text', text: 'persisted worktree turn' }] }) }))
})
