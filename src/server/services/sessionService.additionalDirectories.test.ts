import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleDesktopUiApi } from '../api/desktop-ui.js'
import { handleSessionsApi } from '../api/sessions.js'
import { SessionService } from './sessionService.js'
import { ConversationService } from './conversationService.js'
import { DesktopUiPreferencesService } from './desktopUiPreferencesService.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

let directory: string
let config: string | undefined
let main: string
let extra: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'project-directories-'))
  config = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'config')
  main = join(directory, 'main')
  extra = join(directory, '数据 files')
  await mkdir(main)
  await mkdir(extra)
})
afterEach(async () => {
  if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = config
  await rm(directory, { recursive: true, force: true })
})

async function preferences(method: string, body?: unknown) {
  const url = new URL('http://localhost/api/desktop-ui/preferences/project-directories')
  if (method === 'GET') url.searchParams.set('workDir', main)
  return handleDesktopUiApi(new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), url, url.pathname.split('/').filter(Boolean))
}
async function create() {
  const url = new URL('http://localhost/api/sessions')
  const response = await handleSessionsApi(new Request(url, { method: 'POST', body: JSON.stringify({ workDir: main }) }), url, ['api', 'sessions'])
  expect(response.status).toBe(201)
  return response.json() as Promise<{ sessionId: string; workDir: string }>
}

test('project directories REST save/reload reaches new session CLI and preserves old snapshots across restart and clear', async () => {
  const old = await create()
  const alias = join(directory, 'alias')
  await symlink(extra, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const saved = await preferences('PUT', { workDir: main, additionalDirectories: [extra, alias, main, extra + '/'] })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ additionalDirectories: [extra] })
  expect(await (await preferences('GET')).json()).toMatchObject({ mainDirectory: main, additionalDirectories: [extra] })
  const current = await create()
  expect(current.workDir).toBe(main)
  const service = new SessionService()
  expect((await service.getSessionLaunchInfo(old.sessionId))?.additionalDirectories).toEqual([])
  const launch = await service.getSessionLaunchInfo(current.sessionId)
  expect(launch?.additionalDirectories).toEqual([extra])
  expect((await preferences('PUT', { workDir: main, additionalDirectories: [] })).status).toBe(200)
  await service.appendSessionMetadata(current.sessionId, { workDir: main, runtimeModelId: 'fake-model' })
  await service.clearSessionTranscript(current.sessionId, main)
  const resumed = await new SessionService().getSessionLaunchInfo(current.sessionId)
  expect(resumed?.additionalDirectories).toEqual([extra])
  const conversations = new ConversationService() as any
  conversations.resolveCliArgs = (args: string[]) => args
  for (const resume of [false, true]) {
    const args: string[] = conversations.buildSessionCliArgs(current.sessionId, 'ws://127.0.0.1/fake', resume, undefined, undefined, 'standard', resumed!.additionalDirectories)
    expect(args[args.indexOf('--add-dir') + 1]).toBe(extra)
    expect(args).not.toContain('--dangerously-skip-permissions')
  }
  expect((await new SessionService().getSessionLaunchInfo((await create()).sessionId))?.additionalDirectories).toEqual([])
})

test('legacy project and session fixtures default to no auxiliary access and preserve unknown fields', async () => {
  const prefsPath = join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha', 'desktop-ui.json')
  await mkdir(join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha'), { recursive: true })
  await writeFile(prefsPath, JSON.stringify({ schemaVersion: 6, future: { keep: true }, sidebar: {} }))
  const service = new DesktopUiPreferencesService()
  expect((await service.readPreferences()).preferences.projectAdditionalDirectories).toEqual({})
  await service.updateSidebarPreferences({ pinnedProjects: [main] })
  expect(JSON.parse(await readFile(prefsPath, 'utf8'))).toMatchObject({ schemaVersion: 7, future: { keep: true }, projectAdditionalDirectories: {} })
  const sessionId = '6789beef-1234-4567-89ab-000000000001'
  const projectDir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', sanitizePath(main))
  await mkdir(projectDir, { recursive: true })
  const file = join(projectDir, sessionId + '.jsonl')
  const original = JSON.stringify({ type: 'session-meta', workDir: main, extension: { keep: true } }) + '\n'
  await writeFile(file, original)
  expect((await new SessionService().getSessionLaunchInfo(sessionId))?.additionalDirectories).toEqual([])
  expect(await readFile(file, 'utf8')).toBe(original)
})

test('invalid directory updates fail atomically without changing saved scope', async () => {
  expect((await preferences('PUT', { workDir: main, additionalDirectories: [extra] })).status).toBe(200)
  const file = join(directory, 'file')
  await writeFile(file, 'fixture')
  for (const value of [null, 'not-array', [''], ['  '], ['../relative'], [join(directory, 'missing')], [file], [42], ['C:\\Users\\foreign'], ['ssh://other-host/data']]) {
    const response = await preferences('PUT', { workDir: main, additionalDirectories: value })
    expect(response.status).toBe(400)
    expect(await (await preferences('GET')).json()).toMatchObject({ additionalDirectories: [extra] })
  }
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('inaccessible auxiliary directories fail without changing project configuration', async () => {
  const blocked = join(directory, 'no-access')
  await mkdir(blocked)
  await chmod(blocked, 0)
  try {
    const response = await preferences('PUT', { workDir: main, additionalDirectories: [blocked] })
    expect(response.status).toBe(400)
    expect(await (await preferences('GET')).json()).toMatchObject({ additionalDirectories: [] })
  } finally { await chmod(blocked, 0o700) }
})

test('new tasks report removed auxiliary folders while existing tasks retain their original snapshot', async () => {
  expect((await preferences('PUT', { workDir: main, additionalDirectories: [extra] })).status).toBe(200)
  const created = await create()
  await rm(extra, { recursive: true })
  await expect(new SessionService().createSession(main)).rejects.toThrow('unavailable')
  expect((await new SessionService().getSessionLaunchInfo(created.sessionId))?.additionalDirectories).toEqual([extra])
  expect((await preferences('PUT', { workDir: main, additionalDirectories: [] })).status).toBe(200)
  await create()
})

test('rejects CLI expansion to a different physical directory without overwriting config or creating a new task', async () => {
  expect((await preferences('PUT', { workDir: main, additionalDirectories: [extra] })).status).toBe(200)
  const selected = join(directory, 'mapped ')
  const sibling = join(directory, 'mapped')
  await mkdir(selected)
  await mkdir(sibling)
  const prefsPath = join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha', 'desktop-ui.json')
  const before = await readFile(prefsPath, 'utf8')
  expect((await preferences('PUT', { workDir: main, additionalDirectories: [selected] })).status).toBe(400)
  expect(await readFile(prefsPath, 'utf8')).toBe(before)

  // An older app/config fixture can already contain the unsupported directory.
  // Admission must reject it too, before a placeholder/session can be launched.
  const fixture = JSON.parse(before)
  fixture.projectAdditionalDirectories[main] = [selected]
  await writeFile(prefsPath, JSON.stringify(fixture))
  const url = new URL('http://localhost/api/sessions')
  const response = await handleSessionsApi(new Request(url, { method: 'POST', body: JSON.stringify({ workDir: main }) }), url, ['api', 'sessions'])
  expect(response.status).toBe(400)
  expect((await response.json() as { message: string }).message).toContain('different location')
  await expect(import('node:fs/promises').then(fs => fs.readdir(join(process.env.CLAUDE_CONFIG_DIR!, 'projects')))).rejects.toMatchObject({ code: 'ENOENT' })
})
