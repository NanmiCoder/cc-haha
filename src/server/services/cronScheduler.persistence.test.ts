import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronScheduler } from './cronScheduler'

let directory: string
let previousConfig: string | undefined
let previousIndex: string | undefined
const originalRename = fs.rename
let restoreRename: (() => void) | undefined
const staleRun = { id: 'stale', taskId: 'task', startedAt: '2020-01-01T00:00:00.000Z', status: 'running' }

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'cron-history-lock-'))
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  previousIndex = process.env.CC_HAHA_LOCAL_INDEX
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CC_HAHA_LOCAL_INDEX = 'off'
  await fs.writeFile(join(directory, 'scheduled_tasks_log.json'), JSON.stringify({ runs: [staleRun] }))
})

afterEach(async () => {
  restoreRename?.()
  restoreRename = undefined
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousIndex === undefined) delete process.env.CC_HAHA_LOCAL_INDEX
  else process.env.CC_HAHA_LOCAL_INDEX = previousIndex
  await fs.rm(directory, { recursive: true, force: true })
})

function cleanStaleRun() {
  return (new CronScheduler() as unknown as { cleanupStaleRuns(): Promise<void> }).cleanupStaleRuns()
}

test('persists the completed history mutation after transient replacement locks', async () => {
  let attempts = 0
  const rename = spyOn(fs, 'rename').mockImplementation(async (...args) => {
    if (++attempts <= 2) throw Object.assign(new Error('locked'), { code: 'EPERM' })
    return originalRename(...args)
  })
  restoreRename = () => rename.mockRestore()

  await cleanStaleRun()

  const saved = JSON.parse(await fs.readFile(join(directory, 'scheduled_tasks_log.json'), 'utf8'))
  expect(saved.runs[0]).toMatchObject({ id: 'stale', status: 'failed' })
  expect(attempts).toBe(3)
  expect(await fs.readdir(directory)).toEqual(['scheduled_tasks_log.json'])
})

test.each(['EPERM', 'EIO'])('preserves the original history and reports persistent %s errors', async code => {
  const rename = spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('replacement failed'), { code }))
  restoreRename = () => rename.mockRestore()

  await expect(cleanStaleRun()).rejects.toThrow('replacement failed')

  const saved = JSON.parse(await fs.readFile(join(directory, 'scheduled_tasks_log.json'), 'utf8'))
  expect(saved.runs).toEqual([staleRun])
  expect(rename.mock.calls.length).toBe(code === 'EPERM' ? 6 : 1)
  expect(await fs.readdir(directory)).toEqual(['scheduled_tasks_log.json'])
})
