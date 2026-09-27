import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import { mkdtemp, rm, writeFile, appendFile, rename } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { workflowService } from './workflowService.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkflowTranscriptProjection } from './workflowTranscriptProjection.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'workflow-projection-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const launch = JSON.stringify({ toolUseResult: { runId: 'wf_run', taskId: 'task', taskType: 'local_workflow', status: 'async_launched' } }) + '\n'

test('large histories without workflows retain no bodies and subsequent polls read zero bytes', async () => {
  const file = join(dir, 'session.jsonl')
  await writeFile(file, (JSON.stringify({ message: { content: 'x'.repeat(8192) } }) + '\n').repeat(640))
  const [first, concurrent] = await Promise.all([readWorkflowTranscriptProjection(file), readWorkflowTranscriptProjection(file)])
  expect(first).toBe(concurrent)
  expect(first.complete).toBe(true)
  expect(first.messages).toEqual([])
  expect(first.readBytes).toBeGreaterThan(5 * 1024 * 1024)
  expect((await readWorkflowTranscriptProjection(file)).readBytes).toBe(0)
  await appendFile(file, launch)
  const appended = await readWorkflowTranscriptProjection(file)
  expect(appended.readBytes).toBe(Buffer.byteLength(launch))
  expect(appended.messages).toHaveLength(1)
})

test('retains structured launch, persisted terminal and XML terminal evidence', async () => {
  const file = join(dir, 'session.jsonl')
  const terminal = { type: 'cc-haha-task-notification', taskNotification: { taskId: 'task', status: 'completed' } }
  const xml = { message: { content: [{ type: 'text', text: '<task-notification><task-id>task</task-id><status>completed</status></task-notification>' }] } }
  await writeFile(file, launch + JSON.stringify(terminal) + '\n' + JSON.stringify(xml) + '\n')
  expect((await readWorkflowTranscriptProjection(file)).messages).toEqual([JSON.parse(launch), terminal, xml])
  await writeFile(join(dir, 'replacement'), '{}\n')
  await rename(join(dir, 'replacement'), file)
  expect((await readWorkflowTranscriptProjection(file)).messages).toEqual([])
})

test('oversized records and excessive lifecycle evidence explicitly report incomplete', async () => {
  const file = join(dir, 'session.jsonl')
  await writeFile(file, JSON.stringify({ toolUseResult: { taskType: 'local_workflow', body: 'x'.repeat(2 * 1024 * 1024) } }) + '\n')
  expect((await readWorkflowTranscriptProjection(file)).complete).toBe(false)
  expect((await readWorkflowTranscriptProjection(file)).readBytes).toBe(0)
  await writeFile(file, launch.repeat(10_001))
  const projection = await readWorkflowTranscriptProjection(file)
  expect(projection.complete).toBe(false)
  expect(projection.messages).toHaveLength(10_000)
})


test('workflow reconstruction consumes projected evidence without a whole-file read fallback', async () => {
  const file = join(dir, 'session.jsonl')
  await writeFile(file, launch)
  const readAll = spyOn(fs, 'readFile').mockImplementation(() => { throw new Error('Unbounded read forbidden') })
  try {
    const lifecycle = await (workflowService as unknown as {
      readSessionWorkflowLifecycle(id: string, dirs: Array<{ sessionId: string; dir: string }>): Promise<{ launchesByRunId: Map<string, unknown> }>
    }).readSessionWorkflowLifecycle('session', [{ sessionId: 'session', dir: join(dir, 'session') }])
    expect(lifecycle.launchesByRunId.has('wf_run')).toBe(true)
    expect(readAll).not.toHaveBeenCalled()
  } finally { readAll.mockRestore() }
})
