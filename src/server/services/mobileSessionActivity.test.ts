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

describe('team plans waiting for review', () => {
  test('a finished lead turn whose team plan waits is a decision, not a completed session', () => {
    const rows = projectMobileSessionActivity([
      { id: 'lead', activityState: 'idle', startedAt: 1, lastProgressAt: 2 },
      { id: 'adding', activityState: 'running', startedAt: 3, lastProgressAt: 4 },
      { id: 'approval', activityState: 'waiting', requestId: 'r1', toolName: 'Bash', preview: 'ls' },
    ], [{ id: 'lead', state: 'completed', completedAt }], [], since, [
      { sessionId: 'lead', addition: false },
      { sessionId: 'adding', addition: true },
      { sessionId: 'approval', addition: false },
      { sessionId: 'not-open', addition: false },
    ])
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('lead')).toEqual({ id: 'lead', activityState: 'waiting', decision: 'team_plan', preview: '团队组好了，等你确认', startedAt: 1, lastProgressAt: 2 })
    // Members already running keep working; the addition still needs the user.
    expect(byId.get('adding')).toMatchObject({ activityState: 'waiting', decision: 'team_plan', preview: '要追加的成员等你确认' })
    // A tool permission answerable from the list wins.
    expect(byId.get('approval')).toEqual({ id: 'approval', activityState: 'waiting', requestId: 'r1', toolName: 'Bash', preview: 'ls' })
    // The lead process may have exited; the plan still waits.
    expect(byId.get('not-open')).toMatchObject({ activityState: 'waiting', decision: 'team_plan' })
  })

  test('the loader reads plan reviews after live state', async () => {
    const rows = await loadMobileSessionActivity({
      live: () => [{ id: 'lead', activityState: 'idle' }],
      completions: async () => [],
      runs: async () => ({ runs: [], revisionToken: 'r' }) as never,
      teamReviews: async () => [{ sessionId: 'lead', addition: false }],
      now: () => now,
    })
    expect(rows).toEqual([{ id: 'lead', activityState: 'waiting', decision: 'team_plan', preview: '团队组好了，等你确认' }])
  })
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
