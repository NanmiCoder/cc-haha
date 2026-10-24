import { expect, test } from 'bun:test'
import {
  activityBridgeAction,
  activityUrl,
  staleActivityProps,
  taskActivityData,
} from './activityData'
import type { Host, Session } from '../core/types'
const host: Host = {
  id: 'host-a',
  name: 'Work Mac',
  auth: 'lan',
  url: 'http://192.168.1.2:3456',
}
const sessions = [
  { id: 'one', title: 'Real task' },
  { id: 'two', title: 'Other task' },
] as Session[]
test('lock screen displays only real sessions and picks waiting approvals ahead of running work', () => {
  const value = taskActivityData(
    host,
    sessions,
    [
      { id: 'two', activityState: 'running' },
      {
        id: 'one',
        activityState: 'waiting',
        requestId: 'request-id',
        toolName: 'Bash',
        preview: 'bun test',
      },
    ],
    true,
    100
  )
  expect(value).toMatchObject({
    title: 'Real task',
    detail: '想运行 bun test',
    activeCount: 2,
    status: 'waiting',
  })
  expect(value?.allowUrl).toBe(
    'cchaha:///chat/one?host=host-a&requestId=request-id&notificationAction=allow'
  )
  expect(JSON.stringify(value)).not.toContain('192.168')
  expect(
    taskActivityData(
      host,
      [],
      [{ id: 'one', activityState: 'running' }],
      true,
      100
    )
  ).toBeNull()
})
test.each(['AskUserQuestion', 'ExitPlanMode', 'ComputerUse'])(
  'complex %s approval opens the actual App form and has no fake allow button',
  (toolName) => {
    const result = taskActivityData(
      host,
      sessions,
      [{ id: 'one', activityState: 'waiting', requestId: 'req', toolName }],
      true,
      100
    )
    expect(result?.allowUrl).toBeUndefined()
    expect(result?.denyUrl).toBeUndefined()
    expect(result?.openUrl).toBe(activityUrl(host.id, 'one'))
  }
)
test('expired decisions and disabled decision notifications do not expose action links', () => {
  const activity = [
    {
      id: 'one',
      activityState: 'waiting' as const,
      requestId: 'req',
      toolName: 'Bash',
      autoAnswerDeadline: 50,
    },
  ]
  expect(
    taskActivityData(host, sessions, activity, true, 100)?.allowUrl
  ).toBeUndefined()
  expect(taskActivityData(host, sessions, activity, false, 100)).toBeNull()
})

test('foreground stale or offline snapshots cannot refresh approvals while background APNs remains independent', () => {
  const healthy = {
    hostsReady: true,
    preferencesReady: true,
    preferencesError: false,
    hasHosts: true,
    foreground: true,
    fresh: true,
    error: false,
    hasSnapshot: true,
    hasClient: true,
  }
  expect(activityBridgeAction(healthy)).toBe('sync')
  expect(activityBridgeAction({ ...healthy, fresh: false })).toBe('stale')
  expect(activityBridgeAction({ ...healthy, error: true })).toBe('stale')
  expect(activityBridgeAction({ ...healthy, hasSnapshot: false })).toBe('stale')
  expect(
    activityBridgeAction({ ...healthy, foreground: false, fresh: false })
  ).toBe('preserve')
  expect(activityBridgeAction({ ...healthy, preferencesReady: false })).toBe(
    'end'
  )
  expect(activityBridgeAction({ ...healthy, preferencesError: true })).toBe(
    'end'
  )
})

test('marking a known activity stale strips both decisions while retaining only its safe open link', () => {
  const fresh = taskActivityData(
    host,
    sessions,
    [
      {
        id: 'one',
        activityState: 'waiting',
        requestId: 'req',
        toolName: 'Bash',
      },
    ],
    true,
    100
  )!
  const stale = staleActivityProps(fresh)
  expect(fresh.allowUrl).toBeDefined()
  expect(stale.connectionState).toBe('stale')
  expect(stale.allowUrl).toBeUndefined()
  expect(stale.denyUrl).toBeUndefined()
  expect(stale.openUrl).toBe(fresh.openUrl)
})

test('stopped, disappeared and unknown idle tasks end the local activity without synthesizing success', () => {
  for (const activity of [
    [],
    [{ id: 'one', activityState: 'idle' as const }],
    [{ id: 'one', activityState: 'idle' as const, terminalOutcome: 'stopped' as const }],
    [{ id: 'one', activityState: 'failed' as const, terminalOutcome: 'failed' as const }],
  ]) expect(taskActivityData(host, sessions, activity, true, 100)).toBeNull()
})
