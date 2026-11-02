import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionService } from './sessionService.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { formatScheduledTaskPrompt } from '../../utils/scheduledTaskMessage.js'
import { translateCliMessage } from '../ws/handler.js'

let dir: string
let oldConfig: string | undefined
let oldIndex: string | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scheduled-history-'))
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

test('scheduled provenance survives transcript history and SDK replay while legacy user text stays ordinary', async () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const project = join(dir, 'projects', sanitizePath(dir))
  await mkdir(project, { recursive: true })
  const scheduledTask = { taskId: 'task', runId: 'run', scheduledFor: '2026-10-26T01:00:00Z', taskName: 'Check' }
  const content = formatScheduledTaskPrompt('Check saved task', 'run', true)
  const records = [
    { type: 'session-meta', workDir: dir },
    { type: 'user', uuid: 'legacy', timestamp: '2026-10-26T01:00:00Z', message: { role: 'user', content } },
    { type: 'user', uuid: 'scheduled', timestamp: '2026-10-26T01:01:00Z', scheduledTask, message: { role: 'user', content } },
  ]
  await writeFile(join(project, `${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const page = await new SessionService().getSessionHistoryPage(id, { limit: 20, projectContext: false })
  expect(page.messages.find(message => message.id === 'scheduled')).toMatchObject({ content: 'Check saved task', scheduledTask })
  expect(page.messages.find(message => message.id === 'legacy')).toMatchObject({ content })
  expect(page.messages.find(message => message.id === 'legacy')?.scheduledTask).toBeUndefined()
  expect(translateCliMessage({ ...records[2], isReplay: true }, id)).toContainEqual({ type: 'user_message_replay', content: 'Check saved task', scheduledTask })
  const ordinary = translateCliMessage({ ...records[1], isReplay: true }, id)
  expect(ordinary.some(message => message.type === 'user_message_replay' && message.scheduledTask)).toBe(false)
})
