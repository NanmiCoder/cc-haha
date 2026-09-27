import { afterEach, beforeEach, expect, spyOn, mock, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionService } from './sessionService.js'
import type { LocalIndexGateway } from './localIndex/sessionIndex.js'

let directory: string
let previousHome: string | undefined
let previousConfig: string | undefined

beforeEach(async () => {
  directory = await mkdtemp('/tmp/session-metadata-')
  previousHome = process.env.HOME
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = directory
})

afterEach(async () => {
  mock.restore()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await rm(directory, { recursive: true, force: true })
})

test('building index serves bounded metadata without canonical hydration', async () => {
  const rows = [{ id: 'old', title: '设计', workDir: '/fixture', projectPath: 'fixture', modifiedAt: '2026-01-01' }]
  const gateway = {
    getMode: () => 'on',
    getPublicStatus: () => ({ state: 'building' }),
    searchSessionMetadata: () => ({ sessions: rows, total: 1 }),
    getSessionSuggestionMetadata: () => rows,
  } as unknown as LocalIndexGateway
  const service = new SessionService(gateway)
  const hydrate = spyOn(service, 'listSessions').mockImplementation(async () => {
    throw new Error('no hydration')
  })
  expect((await service.searchSessionMetadata('设计')).sessions).toEqual(rows)
  expect(service.getSessionSuggestionMetadata(['old'])).toEqual(rows)
  expect(hydrate).not.toHaveBeenCalled()
  const abort = new AbortController()
  abort.abort()
  await expect(service.searchSessionMetadata('设计', { signal: abort.signal })).rejects.toThrow()
})

test('unavailable index scans cached summaries once and ranks old exact matches before limiting', async () => {
  const project = join(directory, 'projects', 'fixture')
  await mkdir(project, { recursive: true })
  for (let i = 0; i < 45; i++) {
    await writeFile(join(project, `id-${i}.jsonl`), JSON.stringify({
      type: 'custom-title',
      customTitle: i === 44 ? '设计' : '最近设计讨论',
      sessionId: `id-${i}`,
    }) + '\n')
  }
  const service = new SessionService({ getMode: () => 'off' } as unknown as LocalIndexGateway)
  const hydrate = spyOn(service, 'listSessions').mockImplementation(async () => {
    throw new Error('no hydration')
  })
  const result = await service.searchSessionMetadata('设计', { limit: 5 })
  expect(result.sessions[0]?.id).toBe('id-44')
  expect(result.total).toBe(45)
  expect(result.sessions).toHaveLength(5)
  expect(hydrate).not.toHaveBeenCalled()
  expect(service.getSessionSuggestionMetadata(['id-44'])).toEqual([])
})
