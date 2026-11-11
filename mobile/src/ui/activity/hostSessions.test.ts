import { expect, test } from 'bun:test'
import type { DashboardSnapshot } from '../../core/dashboardSync'
import type { MobileActivity } from '../../core/dashboard'
import type { Session } from '../../core/types'
import { activeSessions } from './hostSessions'

const session = (id: string, title: string, modifiedAt: string): Session => ({
  id,
  title,
  createdAt: modifiedAt,
  modifiedAt,
  messageCount: 1,
  projectPath: '/p',
  workDir: '/p',
  workDirExists: true,
})
const activity = (id: string, activityState: MobileActivity['activityState']): MobileActivity => ({
  id,
  activityState,
})

test('uses the dashboard snapshot: waiting first, then running, idle excluded', async () => {
  const snapshot: DashboardSnapshot = {
    hostId: 'h',
    sessions: [
      session('run', '扫码配对', '2026-10-25T10:00:00Z'),
      session('wait', '', '2026-10-25T09:00:00Z'),
      session('idle', '发版说明', '2026-10-25T11:00:00Z'),
    ],
    activity: [activity('run', 'running'), activity('wait', 'waiting'), activity('idle', 'idle')],
    total: 3,
    checkedAt: 0,
  }
  const client = {
    async get<T>(): Promise<T> {
      throw new Error('snapshot path must not hit the network')
    },
  }
  expect(await activeSessions(client, snapshot)).toEqual([
    { id: 'wait', title: '未命名会话' },
    { id: 'run', title: '扫码配对' },
  ])
})

test('without a snapshot it reads mobile-status and tolerates a missing summary', async () => {
  const paths: string[] = []
  const client = {
    async get<T>(path: string): Promise<T> {
      paths.push(path)
      if (path === '/api/sessions/mobile-status')
        return {
          sessions: [
            activity('a', 'running'),
            activity('b', 'idle'),
            activity('c', 'waiting'),
            activity('a', 'running'),
          ],
        } as T
      if (path.includes('/c/')) throw new Error('gone')
      return session('a', '排查内存', '2026-10-25T10:00:00Z') as T
    },
  }
  expect(await activeSessions(client, null)).toEqual([
    { id: 'c', title: '未命名会话' },
    { id: 'a', title: '排查内存' },
  ])
  expect(paths).toEqual([
    '/api/sessions/mobile-status',
    '/api/sessions/c/summary',
    '/api/sessions/a/summary',
  ])
})
