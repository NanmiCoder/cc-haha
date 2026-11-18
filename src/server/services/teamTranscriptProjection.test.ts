import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTeamTranscriptProjection } from './teamTranscriptProjection.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'team-projection-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const tool = (id: string, name: string, input: unknown) => JSON.stringify({ uuid: id, timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) + '\n'

describe('bounded Team transcript projection', () => {
  test('caches empty large histories and only scans subsequently appended bytes', async () => {
    const file = join(dir, 'session.jsonl')
    const unrelated = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(8192) }] } }) + '\n'
    await writeFile(file, unrelated.repeat(640))
    const [first, concurrent] = await Promise.all([readTeamTranscriptProjection(file), readTeamTranscriptProjection(file)])
    expect(first).toBe(concurrent)
    expect(first.complete).toBe(true)
    expect(first.messages).toEqual([])
    expect(first.readBytes).toBeGreaterThan(5 * 1024 * 1024)
    expect((await readTeamTranscriptProjection(file)).readBytes).toBe(0)
    const appended = tool('create', 'TeamCreate', { team_name: 'test' })
    await appendFile(file, appended)
    const changed = await readTeamTranscriptProjection(file)
    expect(changed.readBytes).toBe(Buffer.byteLength(appended))
    expect(changed.messages).toHaveLength(1)
  })

  test('preserves paired task results and Team lifecycle evidence across appends', async () => {
    const file = join(dir, 'session.jsonl')
    await writeFile(file, tool('team', 'TeamCreate', { team_name: 'test' }) + tool('task', 'TaskCreate', { subject: 'Keep task' }) + tool('task-denied', 'TaskUpdate', { taskId: '1' }) + tool('task-bad', 'TaskList', {}))
    await readTeamTranscriptProjection(file)
    await appendFile(
      file,
      JSON.stringify({ uuid: 'result', timestamp: '2026-01-01T00:00:01Z', durationMs: 185, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task', content: '{"task":{"id":"1"}}' }] }, toolUseResult: { task: { id: '1' }, taskListMutationRevision: 2 } }) + '\n' +
      JSON.stringify({ uuid: 'result-zero', timestamp: '2026-01-01T00:00:02Z', durationMs: 0, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task-denied', content: 'denied', is_error: true }] } }) + '\n' +
      JSON.stringify({ uuid: 'result-neg', timestamp: '2026-01-01T00:00:03Z', durationMs: -5, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task-bad', content: 'ok' }] } }) + '\n' +
      tool('delete', 'TeamDelete', {}),
    )
    const projection = await readTeamTranscriptProjection(file)
    expect(projection.messages).toHaveLength(8)
    expect(projection.messages[4]?.toolUseResult).toEqual({ task: { id: '1' }, taskListMutationRevision: 2 })
    expect(projection.messages[4]?.durationMs).toBe(185)
    expect(projection.messages[5]?.durationMs).toBe(0)
    expect('durationMs' in projection.messages[6]!).toBe(false)
  })

  test('rebuilds after truncation and retries a partial tail after completion', async () => {
    const file = join(dir, 'session.jsonl')
    const create = tool('team', 'TeamCreate', { team_name: 'first' })
    await writeFile(file, create.slice(0, -2))
    expect((await readTeamTranscriptProjection(file)).complete).toBe(false)
    await appendFile(file, create.slice(-2))
    expect((await readTeamTranscriptProjection(file)).messages).toHaveLength(1)
    expect((await readTeamTranscriptProjection(file)).complete).toBe(true)
    await writeFile(file, '{}\n')
    expect((await readTeamTranscriptProjection(file)).messages).toEqual([])
  })

  test('signals incomplete evidence instead of claiming a missing team for oversized input', async () => {
    const file = join(dir, 'session.jsonl')
    await writeFile(file, tool('large', 'TeamCreate', { team_name: 'test', description: 'x'.repeat(2 * 1024 * 1024) }))
    const projection = await readTeamTranscriptProjection(file)
    expect(projection.complete).toBe(false)
    expect(projection.messages).toEqual([])
    expect((await readTeamTranscriptProjection(file)).readBytes).toBe(0)
  })
})
