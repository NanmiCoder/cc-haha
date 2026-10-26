import { describe, expect, test } from 'bun:test'
import { loadMobileSessionActivity, projectMobileSessionActivity } from './mobileSessionActivity.js'
import type { TaskRun } from './cronScheduler.js'

const now = Date.parse('2026-10-24T12:00:00Z')
const completedAt = '2026-10-24T10:00:00Z'
const since = now - 48 * 60 * 60 * 1000
const run = (sessionId: string, overrides: Partial<TaskRun> = {}): TaskRun => ({
  id: `run-${sessionId}`, taskId: 'task', taskName: 'Fixture', prompt: 'No model', sessionId,
  startedAt: '2026-10-24T09:00:00Z', completedAt, status: 'completed', ...overrides,
})

describe('persistent mobile completion projection', () => {
  test('runtime idle/finished clocks and old completed records never invent successful completion', () => {
    const rows = projectMobileSessionActivity([
      { id: 'stopped', activityState: 'idle', completedAt: now },
      { id: 'failed', activityState: 'failed', completedAt: now },
      { id: 'unknown', activityState: 'idle' },
    ], [{ id: 'old', state: 'completed' }], [], since)
    expect(rows.every(row => row.completedAt === undefined)).toBe(true)
    expect(rows.some(row => row.id === 'old')).toBe(false)
  })

  test('durable and scheduled evidence survives absent runtimes, deduplicates by session and honors live work', () => {
    const rows = projectMobileSessionActivity([
      { id: 'manual', activityState: 'idle', completedAt: 1 },
      { id: 'waiting', activityState: 'waiting', requestId: 'approval', preview: 'Real pending request' },
    ], [
      { id: 'manual', state: 'completed', completedAt },
      { id: 'closed', state: 'completed', completedAt },
      { id: 'waiting', state: 'completed', completedAt },
      { id: 'stopped', state: 'stopped', completedAt },
    ], [run('manual'), run('scheduled'), run('stopped'), run('failed', { status: 'failed' }), run('unknown-time', { completedAt: undefined }), run('timeout', { status: 'timeout' })], since)
    expect(rows.filter(row => row.completedAt).map(row => row.id).sort()).toEqual(['closed', 'manual', 'scheduled'])
    expect(rows.find(row => row.id === 'manual')?.completedAt).toBe(Date.parse(completedAt))
    expect(rows.filter(row => row.id === 'manual')).toHaveLength(1)
    expect(rows.find(row => row.id === 'waiting')).toEqual({ id: 'waiting', activityState: 'waiting', requestId: 'approval', preview: 'Real pending request' })
  })

  test('new failed scheduled result cannot inherit an earlier successful run on the same session', () => {
    expect(projectMobileSessionActivity([], [], [run('same'), run('same', { id: 'new-run', startedAt: '2026-10-24T11:00:00Z', status: 'failed' })], since)).toEqual([])
  })

  test('all scheduled pages are consumed before the final live snapshot, without cloning collaboration messages', async () => {
    const calls: string[] = []
    const rows = await loadMobileSessionActivity({
      now: () => now,
      runs: async options => {
        expect(options).toMatchObject({ summaryOnly: true, completedAfterMs: since, limit: 500 })
        calls.push(options?.cursor ?? 'first')
        return options?.cursor
          ? { runs: [run('second')], revisionToken: 'stable' }
          : { runs: [run('first')], nextCursor: 'next', revisionToken: 'stable' }
      },
      completions: async () => { calls.push('completion'); return [{ id: 'manual', state: 'completed', completedAt }] },
      live: () => { calls.push('live'); return [] },
    })
    expect(calls).toEqual(['first', 'next', 'completion', 'live'])
    expect(rows.map(row => row.id)).toEqual(['first', 'second', 'manual'])
  })

  test('a moving or stuck scheduled cursor fails explicitly instead of returning partial totals', async () => {
    for (const reset of [false, true]) {
      let reads = 0
      await expect(loadMobileSessionActivity({
        now: () => now, completions: async () => [], live: () => [],
        runs: async () => ({ runs: [], nextCursor: 'same', revisionToken: 'v1', ...(reset && ++reads > 1 ? { reset: true } : {}) }),
      })).rejects.toThrow(reset ? 'Scheduled history changed' : 'Scheduled history cursor did not advance')
    }
  })
})
