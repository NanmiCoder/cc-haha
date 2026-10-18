import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './sessionService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
let directory: string
let file: string
let oldHome: string | undefined
let oldConfig: string | undefined
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-metadata-'))
  oldHome = process.env.HOME
  oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = directory
  resetSettingsCache()
  const project = join(directory, 'projects', sanitizePath(directory))
  await mkdir(project, { recursive: true })
  file = join(project, `${sessionId}.jsonl`)
})
afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME
  else process.env.HOME = oldHome
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfig
  resetSettingsCache()
  await rm(directory, { recursive: true, force: true })
})

test('new lean session survives restart, runtime metadata append, clear and full detail', async () => {
  const service = new SessionService()
  const created = await service.createSession(directory, undefined, 'default', 'lean')
  expect(created.agentProfile).toBe('lean')
  const info = await service.getSessionLaunchInfo(created.sessionId)
  await import('node:fs/promises').then(fs => fs.appendFile(info!.filePath, JSON.stringify({ type: 'session-meta', futureExtension: { keep: true } }) + '\n'))
  await service.appendSessionMetadata(created.sessionId, { workDir: created.workDir, runtimeModelId: 'fake-model' })
  const restarted = new SessionService()
  expect((await restarted.getSessionLaunchInfo(created.sessionId))?.agentProfile).toBe('lean')
  expect((await restarted.getSessionSummary(created.sessionId))?.agentProfile).toBe('lean')
  expect((await restarted.getSession(created.sessionId))?.agentProfile).toBe('lean')
  await restarted.clearSessionTranscript(created.sessionId, created.workDir)
  expect((await new SessionService().getSessionLaunchInfo(created.sessionId))?.agentProfile).toBe('lean')
  const saved = (await readFile(info!.filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(saved.find(entry => entry.type === 'session-meta')).toMatchObject({ agentProfile: 'lean', futureExtension: { keep: true } })
})

test('legacy session defaults to standard without rewriting unknown fields', async () => {
  const original = JSON.stringify({ type: 'session-meta', workDir: directory, futureExtension: 42 }) + '\n'
  await writeFile(file, original)
  const service = new SessionService()
  expect((await service.getSessionLaunchInfo(sessionId))?.agentProfile).toBe('standard')
  expect((await service.getSessionSummary(sessionId))?.agentProfile).toBe('standard')
  expect(await readFile(file, 'utf8')).toBe(original)
})

test('HTTP rejects profile changes and unsupported lean branch/side-chat capabilities', async () => {
  const { handleSessionsApi } = await import('../api/sessions.js')
  const created = await new SessionService().createSession(directory, undefined, undefined, 'lean')
  for (const [method, suffix, body] of [
    ['PATCH', '', { title: 'changed', agentProfile: 'standard' }],
    ['POST', '/branch', {}], ['POST', '/side-chats', {}], ['POST', '/side-question', {}],
  ] as const) {
    const url = new URL(`http://localhost/api/sessions/${created.sessionId}${suffix}`)
    const response = await handleSessionsApi(new Request(url, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), url, url.pathname.split('/').filter(Boolean))
    expect(response.status).toBe(409)
  }
  expect((await new SessionService().getSessionLaunchInfo(created.sessionId))?.agentProfile).toBe('lean')
})

test('each CLI launch and resume receives its own persisted profile', async () => {
  const { ConversationService } = await import('./conversationService.js')
  const service = new ConversationService() as any
  service.resolveCliArgs = (args: string[]) => args
  for (const resume of [false, true]) {
    for (const profile of ['standard', 'lean']) {
      const args = service.buildSessionCliArgs(sessionId, 'ws://127.0.0.1/fake', resume, undefined, undefined, profile)
      expect(args[args.indexOf('--agent-profile') + 1]).toBe(profile)
      expect(args).toContain(resume ? '--resume' : '--session-id')
    }
  }
})


test('HTTP creates only supported profiles and rejects invalid profile before writing', async () => {
  const { handleSessionsApi } = await import('../api/sessions.js')
  for (const profile of ['standard', 'lean', 'invalid']) {
    const url = new URL('http://localhost/api/sessions')
    const response = await handleSessionsApi(new Request(url, { method: 'POST', body: JSON.stringify({ workDir: directory, agentProfile: profile }), headers: { 'Content-Type': 'application/json' } }), url, ['api', 'sessions'])
    expect(response.status).toBe(profile === 'invalid' ? 400 : 201)
    if (profile !== 'invalid') {
      const created = await response.json() as { sessionId: string; agentProfile: string }
      expect(created.agentProfile).toBe(profile)
      expect((await new SessionService().getSessionLaunchInfo(created.sessionId))?.agentProfile).toBe(profile)
    }
  }
})


test('lean rejects plan creation, persisted updates and startup before launch', async () => {
  const service = new SessionService()
  await expect(service.createSession(directory, undefined, 'plan', 'lean')).rejects.toThrow('Plan mode')
  const created = await service.createSession(directory, undefined, 'default', 'lean')
  await expect(service.appendSessionMetadata(created.sessionId, { workDir: directory, permissionMode: 'plan' })).rejects.toThrow('Plan mode')
  const { ConversationService } = await import('./conversationService.js')
  const conversations = new ConversationService()
  await expect(conversations.startSession(created.sessionId, directory, 'ws://127.0.0.1/fake', { permissionMode: 'plan' })).rejects.toThrow('Plan mode')
  await expect(conversations.setPermissionMode(created.sessionId, 'plan')).rejects.toThrow('Plan mode')
  expect((await service.getSessionLaunchInfo(created.sessionId))?.permissionMode).toBe('default')
  // A legacy incompatible stored mode is repairable without changing profile.
  const info = await service.getSessionLaunchInfo(created.sessionId)
  await import('node:fs/promises').then(fs => fs.appendFile(info!.filePath, JSON.stringify({ type: 'session-meta', permissionMode: 'plan' }) + '\n'))
  await service.appendSessionMetadata(created.sessionId, { workDir: directory, permissionMode: 'default' })
  expect((await service.getSessionLaunchInfo(created.sessionId))?.permissionMode).toBe('default')
})

test('lean HTTP rejects plan and exposes user skill discovery without compiled commands', async () => {
  const skillDir = join(directory, '.claude', 'skills', 'lean-fixture')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: lean-fixture\ndescription: Test fixture skill\n---\nDo fixture work.')
  const forkDir = join(directory, '.claude', 'skills', 'fork-fixture')
  await mkdir(forkDir, { recursive: true })
  await writeFile(join(forkDir, 'SKILL.md'), '---\nname: fork-fixture\ndescription: Fork fixture\ncontext: fork\n---\nDelegate work.')
  const { handleSessionsApi } = await import('../api/sessions.js')
  const url = new URL('http://localhost/api/sessions')
  const rejected = await handleSessionsApi(new Request(url, { method: 'POST', body: JSON.stringify({ workDir: directory, agentProfile: 'lean', permissionMode: 'plan' }) }), url, ['api', 'sessions'])
  expect(rejected.status).toBe(400)
  const created = await new SessionService().createSession(directory, undefined, 'default', 'lean')
  const catalogUrl = new URL(`${url}/${created.sessionId}/slash-commands`)
  const response = await handleSessionsApi(new Request(catalogUrl), catalogUrl, catalogUrl.pathname.split('/').filter(Boolean))
  expect(response.status).toBe(200)
  const catalog = await response.json() as { commands: { name: string; kind: string }[] }
  expect(catalog.commands.some(command => command.name === 'lean-fixture')).toBe(true)
  expect(catalog.commands.some(command => command.name === 'fork-fixture')).toBe(false)
  expect(catalog.commands.every(command => command.kind === 'skill')).toBe(true)
  const { handleSkillsApi } = await import('../api/skills.js')
  const mentionsUrl = new URL('http://localhost/api/skills/mentions')
  mentionsUrl.searchParams.set('cwd', directory)
  mentionsUrl.searchParams.set('agentProfile', 'lean')
  const mentionsResponse = await handleSkillsApi(new Request(mentionsUrl), mentionsUrl, ['api', 'skills', 'mentions'])
  const mentions = await mentionsResponse.json() as { skills: { name: string }[]; plugins: unknown[] }
  expect(mentions.skills.some(skill => skill.name === 'lean-fixture')).toBe(true)
  expect(mentions.skills.some(skill => skill.name === 'fork-fixture')).toBe(false)
  expect(mentions.plugins).toEqual([])
})
