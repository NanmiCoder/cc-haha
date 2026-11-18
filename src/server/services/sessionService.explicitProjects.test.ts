import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleDesktopUiApi } from '../api/desktop-ui.js'
import { handleSessionsApi } from '../api/sessions.js'
import { SessionService } from './sessionService.js'
import { prepareSessionWorkspace } from './repositoryLaunchService.js'
import { DesktopUiPreferencesService } from './desktopUiPreferencesService.js'

let directory: string
let originalConfig: string | undefined
let repository: string
let child: string
let extra: string

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'explicit-projects-')))
  originalConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'config')
  repository = join(directory, 'obsidian')
  child = join(repository, 'projects', 'Tools', '输入法')
  extra = join(directory, 'extra')
  await mkdir(child, { recursive: true })
  await mkdir(extra)
  const git = Bun.spawnSync(['git', 'init', repository], { stdout: 'ignore', stderr: 'pipe' })
  expect(git.exitCode).toBe(0)
})

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  await rm(directory, { recursive: true, force: true })
})

async function saveProject(workDir: string, additionalDirectories: string[], createProject = false) {
  const url = new URL('http://localhost/api/desktop-ui/preferences/project-directories')
  const response = await handleDesktopUiApi(new Request(url, {
    method: 'PUT', body: JSON.stringify({ workDir, additionalDirectories, ...(createProject ? { createProject: true } : {}) }),
  }), url, ['api', 'desktop-ui', 'preferences', 'project-directories'])
  expect(response.status).toBe(200)
  return response.json() as Promise<{ projectKey: string; mainDirectory: string; additionalDirectories: string[] }>
}

async function recentRoots() {
  const url = new URL('http://localhost/api/sessions/recent-projects?limit=100')
  const response = await handleSessionsApi(new Request(url), url, ['api', 'sessions', 'recent-projects'])
  expect(response.status).toBe(200)
  return (await response.json() as { projects: Array<{ realPath: string }> }).projects.map(project => project.realPath)
}

test('explicit nested project stays independent across cached lists, history, detail, archives and restart', async () => {
  const sessions = new SessionService()
  const parent = await sessions.createSession(repository)
  const oldChild = await sessions.createSession(child)
  await saveProject(repository, [extra])
  expect((await sessions.listSessions({ limit: 100 })).sessions.map(session => session.projectRoot)).toEqual([repository, repository])
  const oldPage = await sessions.listProjectHistory({ projectRoot: repository, limit: 1 })
  expect(oldPage.nextCursor).not.toBeNull()
  expect(await recentRoots()).toEqual([repository])

  // The selected subdirectory is the project identity even inside a Git repo.
  expect(await saveProject(child, [], true)).toMatchObject({ projectKey: child, mainDirectory: child })
  const preferences = new DesktopUiPreferencesService()
  expect((await preferences.getProjectDirectories(repository)).additionalDirectories).toEqual([extra])
  expect((await preferences.getProjectDirectories(child)).additionalDirectories).toEqual([])
  expect((await sessions.listSessions({ limit: 100 })).sessions.find(session => session.id === oldChild.sessionId)?.projectRoot).toBe(child)
  expect((await sessions.getSession(oldChild.sessionId))?.projectRoot).toBe(child)
  expect((await sessions.listProjectHistory({ projectRoot: repository })).sessions.map(session => session.id)).toEqual([parent.sessionId])
  expect((await sessions.listProjectHistory({ projectRoot: child })).sessions.map(session => session.id)).toEqual([oldChild.sessionId])
  await expect(sessions.listProjectHistory({ projectRoot: repository, cursor: oldPage.nextCursor! })).rejects.toMatchObject({ statusCode: 409 })
  expect(new Set(await recentRoots())).toEqual(new Set([repository, child]))
  expect((await sessions.listProjectPreviews()).projects.map(project => project.projectRoot).sort()).toEqual([repository, child].sort())

  const created = await sessions.createSession(child)
  expect((await sessions.getSessionLaunchInfo(created.sessionId))?.additionalDirectories).toEqual([])
  await sessions.setSessionArchived(created.sessionId, true)
  const restarted = new SessionService()
  expect((await restarted.listSessions({ archived: true })).sessions.find(session => session.id === created.sessionId)?.projectRoot).toBe(child)
  expect((await restarted.listProjectHistory({ projectRoot: child, archived: true })).sessions.map(session => session.id)).toEqual([created.sessionId])
})

test('nearest registered ancestor wins while ordinary sibling sessions keep the Git root', async () => {
  await saveProject(child, [extra], true)
  const nested = join(child, 'src')
  const sibling = join(repository, 'other')
  await mkdir(nested)
  await mkdir(sibling)
  const sessions = new SessionService()
  const nestedSession = await sessions.createSession(nested)
  const siblingSession = await sessions.createSession(sibling)
  expect((await sessions.getSession(nestedSession.sessionId))?.projectRoot).toBe(child)
  expect((await sessions.getSessionLaunchInfo(nestedSession.sessionId))?.additionalDirectories).toEqual([extra])
  expect((await sessions.getSession(siblingSession.sessionId))?.projectRoot).toBe(repository)
  await saveProject(nested, [], true)
  expect((await sessions.getSession(nestedSession.sessionId))?.projectRoot).toBe(nested)
})

test('v7 preference fixture migrates without creating project boundaries or losing extensions', async () => {
  const file = join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha', 'desktop-ui.json')
  await mkdir(join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha'), { recursive: true })
  await writeFile(file, JSON.stringify({ schemaVersion: 7, future: { keep: true }, projectAdditionalDirectories: { [repository]: [extra] } }))
  const service = new DesktopUiPreferencesService()
  expect((await service.readPreferences()).preferences).toMatchObject({ schemaVersion: 8, explicitProjectRoots: [], future: { keep: true } })
  await service.updateProjectDirectories({ workDir: repository, additionalDirectories: [extra] })
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ schemaVersion: 8, explicitProjectRoots: [], future: { keep: true } })
})

test('create preview does not inherit parent auxiliaries or register a root', async () => {
  await saveProject(repository, [extra])
  const url = new URL('http://localhost/api/desktop-ui/preferences/project-directories')
  url.searchParams.set('workDir', child)
  url.searchParams.set('createProject', 'true')
  const response = await handleDesktopUiApi(new Request(url), url, ['api', 'desktop-ui', 'preferences', 'project-directories'])
  expect(await response.json()).toMatchObject({ projectKey: child, mainDirectory: child, additionalDirectories: [] })
  const preferences = new DesktopUiPreferencesService()
  expect((await preferences.readPreferences()).preferences.explicitProjectRoots).toEqual([])
  expect((await preferences.getProjectDirectories(child)).additionalDirectories).toEqual([extra])
  await saveProject(child, [extra], true)
  expect((await preferences.getProjectDirectories(child, { createProject: true })).additionalDirectories).toEqual([extra])
})

test('source project identity and auxiliary scope follow repository and legacy worktree metadata', async () => {
  await saveProject(child, [extra], true)
  const worktree = join(directory, 'isolated-worktree')
  await mkdir(worktree)
  const sessions = new SessionService()
  const fromRepository = await sessions.createSession(worktree)
  await sessions.appendSessionMetadata(fromRepository.sessionId, {
    workDir: worktree,
    repository: { requestedWorkDir: child, repoRoot: repository, branch: 'fixture', worktree: true, baseRef: 'main', worktreePath: worktree },
  })
  expect((await sessions.getSession(fromRepository.sessionId))?.projectRoot).toBe(child)
  const legacy = await sessions.createSession(worktree)
  // Legacy CLI sessions store worktree-state rather than repository metadata.
  const launch = await sessions.getSessionLaunchInfo(legacy.sessionId)
  await writeFile(launch!.filePath, JSON.stringify({ type: 'session-meta', workDir: worktree }) + '\n' + JSON.stringify({
    type: 'worktree-state', worktreeSession: { originalCwd: child, worktreePath: worktree, worktreeName: 'fixture', sessionId: legacy.sessionId },
  }) + '\n')
  expect((await new SessionService().getSession(legacy.sessionId))?.projectRoot).toBe(child)
})


test('an independent nested Git repository keeps its own project root and auxiliary scope', async () => {
  await saveProject(repository, [extra], true)
  const nestedRepository = join(repository, 'independent-repository')
  await mkdir(nestedRepository)
  expect(Bun.spawnSync(['git', 'init', nestedRepository], { stdout: 'ignore', stderr: 'pipe' }).exitCode).toBe(0)
  const sessions = new SessionService()
  const nestedSession = await sessions.createSession(nestedRepository)
  expect((await sessions.getSession(nestedSession.sessionId))?.projectRoot).toBe(nestedRepository)
  expect((await sessions.getSessionLaunchInfo(nestedSession.sessionId))?.additionalDirectories).toEqual([])
})

test('a real isolated worktree inherits the explicitly selected nested project and auxiliary scope', async () => {
  await writeFile(join(repository, 'README.md'), 'fixture\n')
  for (const args of [
    ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'],
  ]) expect(Bun.spawnSync(['git', '-C', repository, ...args], { stdout: 'ignore', stderr: 'pipe' }).exitCode).toBe(0)
  await saveProject(repository, [])
  await saveProject(child, [extra], true)
  const sessions = new SessionService()
  const created = await sessions.createSession(child, { worktree: true })
  const workspace = await prepareSessionWorkspace(child, { worktree: true }, created.sessionId)
  expect(workspace.workDir).not.toBe(child)
  await sessions.appendSessionMetadata(created.sessionId, workspace)
  expect((await sessions.getSessionLaunchInfo(created.sessionId))?.additionalDirectories).toEqual([extra])
  expect((await sessions.getSession(created.sessionId))?.projectRoot).toBe(child)
})


test('repository context exposes project identity separately from the Git root without changing missing-directory behavior', async () => {
  const context = async (workDir: string) => {
    const url = new URL('http://localhost/api/sessions/repository-context')
    url.searchParams.set('workDir', workDir)
    const response = await handleSessionsApi(new Request(url), url, ['api', 'sessions', 'repository-context'])
    expect(response.status).toBe(200)
    return response.json() as Promise<{ state: string; workDir: string; projectRoot: string; repoRoot: string | null }>
  }
  expect(await context(child)).toMatchObject({ projectRoot: repository, repoRoot: repository })
  await saveProject(child, [], true)
  expect(await context(child)).toMatchObject({ projectRoot: child, repoRoot: repository })
  expect(await context(repository)).toMatchObject({ projectRoot: repository, repoRoot: repository })
  expect(await context(join(directory, 'missing'))).toMatchObject({ state: 'missing_workdir', repoRoot: null })
})


test('independent project identity retains native Unicode bytes when the Git parent uses decomposed text', async () => {
  const unicodeRepository = join(directory, 'café'.normalize('NFD'))
  const requestedChild = join(unicodeRepository, '输入法')
  await mkdir(join(unicodeRepository, '.git'), { recursive: true })
  await mkdir(requestedChild)
  const physicalChild = await realpath(requestedChild)
  expect((await saveProject(requestedChild, [], true)).projectKey).toBe(physicalChild)
  const sessions = new SessionService()
  const created = await sessions.createSession(requestedChild)
  expect((await sessions.getSession(created.sessionId))?.projectRoot).toBe(physicalChild)
})

test('creating a branch returns the independent project identity in the refreshed repository context', async () => {
  await writeFile(join(repository, 'README.md'), 'fixture\n')
  for (const args of [
    ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'],
  ]) expect(Bun.spawnSync(['git', '-C', repository, ...args], { stdout: 'ignore', stderr: 'pipe' }).exitCode).toBe(0)
  await saveProject(child, [], true)
  const url = new URL('http://localhost/api/sessions/repository-branch')
  const response = await handleSessionsApi(new Request(url, {
    method: 'POST', body: JSON.stringify({ workDir: child, name: 'fixture-new-branch' }),
  }), url, ['api', 'sessions', 'repository-branch'])
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({
    branch: 'fixture-new-branch',
    context: { projectRoot: child, repoRoot: repository, workDir: child, branches: expect.arrayContaining([expect.objectContaining({ name: 'fixture-new-branch' })]) },
  })
})
