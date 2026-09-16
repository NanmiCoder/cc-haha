import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionService } from './sessionService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let directory: string
let service: SessionService
let previousConfig: string | undefined
let previousHome: string | undefined

async function retention(days: number) {
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ cleanupPeriodDays: days }))
  resetSettingsCache()
}

beforeEach(async () => {
  directory = await mkdtemp('/tmp/session-service-retention-')
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  previousHome = process.env.HOME
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.HOME = directory
  resetSettingsCache()
  service = new SessionService()
})

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  resetSettingsCache()
  await rm(directory, { recursive: true, force: true })
})

async function transcripts() {
  return (await readdir(join(directory, 'projects'), { recursive: true }).catch(() => []))
    .filter(file => file.endsWith('.jsonl'))
}

test('retention zero keeps workspace, runtime and title usable without snapshot/meta/title JSONL', async () => {
  await retention(0)
  const { sessionId, workDir } = await service.createSession(directory, undefined, 'plan')
  await service.appendSessionMetadata(sessionId, {
    workDir, runtimeProviderId: 'fake-provider', runtimeModelId: 'fake-model', effortLevel: 'high',
  })
  await service.renameSession(sessionId, 'PRIVATE-CUSTOM')
  await service.appendAiTitle(sessionId, 'PRIVATE-PROMPT-DERIVED-TITLE')
  expect(await transcripts()).toEqual([])
  expect(await service.getSessionWorkDir(sessionId)).toBe(workDir)
  expect(await service.getCustomTitle(sessionId)).toBe('PRIVATE-CUSTOM')
  expect(await service.getSessionLaunchInfo(sessionId)).toMatchObject({
    workDir, permissionMode: 'plan', runtimeProviderId: 'fake-provider',
    runtimeModelId: 'fake-model', effortLevel: 'high', transcriptMessageCount: 0,
  })
})

test('disabled metadata/title appends leave old files unchanged and clear does not recreate removed history', async () => {
  await retention(365)
  const { sessionId, workDir } = await service.createSession(directory)
  const info = (await service.getSessionLaunchInfo(sessionId))!
  const original = await readFile(info.filePath, 'utf8')
  await retention(0)
  await service.appendSessionMetadata(sessionId, { workDir, customTitle: 'PRIVATE-META', runtimeModelId: 'private-model' })
  await service.appendAiTitle(sessionId, 'PRIVATE-AI')
  expect(await readFile(info.filePath, 'utf8')).toBe(original)
  await rm(info.filePath)
  await service.clearSessionTranscript(sessionId, workDir, 'plan')
  expect(await transcripts()).toEqual([])
  expect(await service.getSessionLaunchInfo(sessionId)).toMatchObject({ workDir, permissionMode: 'plan' })
})


test('restoring persistence cannot copy private custom titles into metadata or save delayed private AI titles', async () => {
  await retention(0)
  const { sessionId, workDir } = await service.createSession(directory)
  await service.renameSession(sessionId, 'PRIVATE-CUSTOM')
  await retention(365)
  const info = (await service.getSessionLaunchInfo(sessionId))!
  // Simulate the runtime materializing only its new public turn.
  await mkdir(join(directory, 'projects', info.projectDir), { recursive: true })
  await writeFile(info.filePath, JSON.stringify({ type: 'user', uuid: 'public-user', message: { role: 'user', content: 'PUBLIC' } }) + '\n')
  await service.appendSessionMetadata(sessionId, { workDir, customTitle: 'PRIVATE-CUSTOM', runtimeModelId: 'public-model' })
  await service.appendAiTitle(sessionId, 'PRIVATE-DELAYED-AI', false)
  await service.appendAiTitle(sessionId, 'Public title')
  const content = await readFile(info.filePath, 'utf8')
  expect(content).not.toContain('PRIVATE')
  expect(content).toContain('Public title')
  expect(await new SessionService().getSessionLaunchInfo(sessionId)).toMatchObject({ workDir, runtimeModelId: 'public-model', transcriptMessageCount: 1 })
})

test('a delayed title never recreates an old transcript deleted after lookup', async () => {
  await retention(365)
  const { sessionId } = await service.createSession(directory)
  const info = (await service.getSessionLaunchInfo(sessionId))!
  const originalFind = service.findSessionFile.bind(service)
  const lookup = spyOn(service, 'findSessionFile').mockImplementation(async id => {
    const found = await originalFind(id)
    await rm(info.filePath)
    return found
  })
  try {
    await service.appendAiTitle(sessionId, 'Delayed old title')
    expect(await transcripts()).toEqual([])
  } finally {
    lookup.mockRestore()
  }
})


test('memory-only sessions can be deleted and cleared without creating JSONL', async () => {
  await retention(0)
  const { sessionId, workDir } = await service.createSession(directory)
  await service.clearSessionTranscript(sessionId, workDir, 'plan')
  await service.deleteSession(sessionId)
  expect(await service.getSessionLaunchInfo(sessionId)).toBeNull()
  expect(await service.getCustomTitle(sessionId)).toBeNull()
  expect(await transcripts()).toEqual([])
})
