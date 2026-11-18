import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError } from '../middleware/errorHandler.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { createTranscriptReadBudget, SessionService } from './sessionService.js'

let dir: string
let oldConfig: string | undefined
let oldIndex: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'session-tool-duration-'))
  oldConfig = process.env.CLAUDE_CONFIG_DIR
  oldIndex = process.env.CC_HAHA_LOCAL_INDEX
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.CC_HAHA_LOCAL_INDEX = 'off'
})

afterEach(async () => {
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfig
  if (oldIndex === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
  else process.env.CC_HAHA_LOCAL_INDEX = oldIndex
  await rm(dir, { recursive: true, force: true })
})

test('SessionService preserves tool_result durationMs across history pagination and omitToolOutputs while leaving legacy entries clean', async () => {
  const id = '11111111-2222-3333-4444-555555555555'
  const project = join(dir, 'projects', sanitizePath(dir))
  await mkdir(project, { recursive: true })
  const records = [
    { type: 'session-meta', workDir: dir },
    { type: 'user', uuid: 'u-prompt', timestamp: '2026-11-16T04:00:00.000Z', message: { role: 'user', content: 'edit files' } },
    {
      type: 'assistant',
      uuid: 'a-calls',
      timestamp: '2026-11-16T04:00:01.000Z',
      message: {
        role: 'assistant',
        id: 'msg_1',
        content: [
          { type: 'tool_use', id: 'edit_1', name: 'Edit', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'edit_legacy', name: 'Edit', input: { file_path: 'b.ts' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'tr-timed',
      timestamp: '2026-11-16T04:00:02.770Z',
      durationMs: 220,
      toolUseResult: 'The file a.ts has been updated.',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'edit_1', content: 'The file a.ts has been updated.' }],
      },
    },
    {
      type: 'user',
      uuid: 'tr-zero',
      timestamp: '2026-11-16T04:00:03.220Z',
      durationMs: 0,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'edit_denied', content: 'User rejected edit', is_error: true }],
      },
    },
    {
      type: 'user',
      uuid: 'tr-legacy',
      timestamp: '2026-11-16T04:00:03.670Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'edit_legacy', content: 'The file b.ts has been updated.' }],
      },
    },
  ]
  await writeFile(join(project, `${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n')

  const service = new SessionService()
  const page = await service.getSessionHistoryPage(id, { limit: 20, projectContext: false })
  const timed = page.messages.find(message => message.id === 'tr-timed')
  const zero = page.messages.find(message => message.id === 'tr-zero')
  const legacy = page.messages.find(message => message.id === 'tr-legacy')

  expect(timed?.durationMs).toBe(220)
  expect(zero?.durationMs).toBe(0)
  expect(legacy).toBeDefined()
  expect('durationMs' in legacy!).toBe(false)

  // omitToolOutputs drops heavy toolUseResult bodies but keeps lightweight durationMs intact.
  const budget = createTranscriptReadBudget({
    maxSourceBytes: 1_000_000,
    maxRetainedBytes: 1_000_000,
    overBudgetError: ApiError.badRequest('over budget'),
  })
  const stripped = await service.getSessionMessages(id, { includeSubagents: false, omitToolOutputs: budget })
  const strippedTimed = stripped.find(message => message.id === 'tr-timed')
  expect(strippedTimed?.toolUseResult).toBeUndefined()
  expect(strippedTimed?.durationMs).toBe(220)
})
