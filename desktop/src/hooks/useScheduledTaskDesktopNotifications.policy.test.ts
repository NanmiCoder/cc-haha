import { expect, it } from 'vitest'
import { collectDesktopNotifiableRuns } from './useScheduledTaskDesktopNotifications'
import type { CronTask, TaskRun, TaskNotificationPolicy } from '@/types/task'

const task: CronTask = { id: 'task', name: 'Check', prompt: 'Check', cron: '0 9 * * *', enabled: true, createdAt: 1, notification: { enabled: true, channels: ['desktop'] } }
const run: TaskRun = { id: 'run', taskId: 'task', taskName: 'Check', prompt: 'Check', startedAt: '2030-01-01T01:00:00Z', status: 'completed' }

it.each<[TaskNotificationPolicy, TaskRun['status'], TaskRun['notificationDecision'], boolean]>([
  ['none', 'completed', 'notify', false],
  ['none', 'failed', undefined, false],
  ['failed', 'completed', 'notify', false],
  ['failed', 'timeout', 'silent', true],
  ['important', 'completed', 'silent', false],
  ['important', 'completed', 'notify', true],
  ['important', 'completed', undefined, true],
  ['important', 'failed', 'silent', true],
  ['all', 'completed', 'silent', true],
])('applies %s to %s with decision %s', (notificationPolicy, status, notificationDecision, expected) => {
  expect(collectDesktopNotifiableRuns([{ ...task, notificationPolicy }], [{ ...run, status, notificationDecision }], new Set())).toHaveLength(expected ? 1 : 0)
})
