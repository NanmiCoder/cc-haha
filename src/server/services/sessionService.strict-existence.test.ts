import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './sessionService.js'

let directory: string
let previous: { config?: string; index?: string }
let service: SessionService
const sessionId = 'cf32fbbc-67ee-4309-b531-dd258547f320'

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'strict-session-existence-'))
  previous = { config: process.env.CLAUDE_CONFIG_DIR, index: process.env.CC_HAHA_LOCAL_INDEX }
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CC_HAHA_LOCAL_INDEX = 'off'
  service = new SessionService()
})

afterEach(async () => {
  mock.restore()
  if (previous.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous.config
  if (previous.index === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
  else process.env.CC_HAHA_LOCAL_INDEX = previous.index
  await fs.rm(directory, { recursive: true, force: true })
})

test('strict caller lookup proves canonical presence or absence without treating project-root files as directories', async () => {
  expect(await service.hasSessionStrict(sessionId)).toBe(false)
  const project = join(directory, 'projects', 'fixture')
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(join(directory, 'projects', '.DS_Store'), 'fixture')
  expect(await service.hasSessionStrict(sessionId)).toBe(false)
  const transcript = join(project, `${sessionId}.jsonl`)
  await fs.writeFile(transcript, JSON.stringify({ type: 'session-meta', sessionId }) + '\n')
  expect(await service.hasSessionStrict(sessionId)).toBe(true)
  expect(await service.hasSessionStrict(`../${sessionId}`)).toBe(false)
  await fs.rm(transcript)
  expect(await service.hasSessionStrict(sessionId)).toBe(false)
})

test.each(['readdir', 'stat'] as const)('strict lookup propagates %s failures while the existing UI lookup stays forgiving', async method => {
  await fs.mkdir(join(directory, 'projects', 'fixture'), { recursive: true })
  const error = Object.assign(new Error('Fixture storage unavailable'), { code: 'EACCES' })
  const denied = spyOn(fs, method).mockRejectedValue(error)
  await expect(service.hasSessionStrict(sessionId)).rejects.toBe(error)
  expect(await service.findSessionFile(sessionId)).toBeNull()
  denied.mockRestore()
})

test('strict lookup rejects a non-file transcript instead of proving deletion', async () => {
  await fs.mkdir(join(directory, 'projects', 'fixture', `${sessionId}.jsonl`), { recursive: true })
  await expect(service.hasSessionStrict(sessionId)).rejects.toMatchObject({ code: 'INVALID_SESSION_TRANSCRIPT' })
})
