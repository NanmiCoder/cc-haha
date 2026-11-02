import { expect, test } from 'bun:test'
import { registerScheduledTaskNotificationRun, reportScheduledTaskNotificationDecision } from './scheduledTaskNotificationDecision.js'

test('only the active scheduled session can decide its notification', () => {
  const run = registerScheduledTaskNotificationRun('run-test', 'session-test')
  try {
    expect(() => reportScheduledTaskNotificationDecision('run-test', 'another-session', 'silent')).toThrow()
    expect(() => reportScheduledTaskNotificationDecision('unknown', 'session-test', 'silent')).toThrow()
    reportScheduledTaskNotificationDecision('run-test', 'session-test', 'silent')
    expect(run.decision()).toBe('silent')
  } finally { run.dispose() }
  expect(() => reportScheduledTaskNotificationDecision('run-test', 'session-test', 'notify')).toThrow()
})
