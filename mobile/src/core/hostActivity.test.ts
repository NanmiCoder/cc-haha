import { expect, test } from 'bun:test'
import { loadHostBackgroundTasks, runningTaskCount } from './hostActivity'
import type { BackgroundSnapshot } from './operations'

test('host activity merges per-session snapshots and skips sessions that fail', async () => {
  const paths: string[] = []
  const client = {
    async get<T>(path: string): Promise<T> {
      paths.push(path)
      if (path.includes('broken')) throw new Error('offline')
      const snapshot: BackgroundSnapshot = {
        historyComplete: true,
        tasks: [
          { taskId: `${path}-a`, status: 'running' },
          { taskId: `${path}-b`, status: 'completed' },
        ],
      }
      return snapshot as T
    },
  }
  const groups = await loadHostBackgroundTasks(client as never, [
    'one',
    'broken',
    'one',
    'two',
  ])
  expect(paths).toEqual([
    '/api/sessions/one/background-tasks',
    '/api/sessions/broken/background-tasks',
    '/api/sessions/two/background-tasks',
  ])
  expect(groups.map((group) => group.sessionId)).toEqual(['one', 'two'])
  expect(runningTaskCount(groups)).toBe(2)
})

test('an empty host has no background work', async () => {
  const client = { get: async () => ({ tasks: [], historyComplete: true }) }
  expect(runningTaskCount(await loadHostBackgroundTasks(client as never, []))).toBe(0)
})
