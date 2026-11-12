import { expect, test } from 'bun:test'
import {
  FINISHED_ACTIVITY_MS,
  activityBridgeAction,
  activityUrl,
  finishedActivities,
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
    label: 'Wants to run a command',
    detail: '$ bun test',
    activeCount: 2,
    status: 'waiting',
  })
  expect(value?.actionLabel).toBeUndefined()
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

test('waiting labels and the single action follow the decision type', () => {
  const waiting = (toolName: string, preview?: string) =>
    taskActivityData(
      host,
      sessions,
      [{ id: 'one', activityState: 'waiting', requestId: 'r', toolName, preview }],
      true,
      100
    )!
  expect(waiting('AskUserQuestion', 'How should old fields be handled?')).toMatchObject({
    label: 'Asking you',
    detail: 'How should old fields be handled?',
    actionLabel: 'Answer',
  })
  expect(waiting('ExitPlanMode', 'Plan awaiting confirmation')).toMatchObject({
    label: 'Plan awaiting your confirmation',
    detail: 'Open the app to see the full plan',
    actionLabel: 'See full plan',
  })
  // Non-Bash previews are generic server placeholders; they are not repeated.
  expect(waiting('Edit', 'Waiting for tool permission')).toMatchObject({
    label: 'Wants to edit files',
    detail: 'Open the app for details',
  })
  expect(waiting('Edit').allowUrl).toBeDefined()
  expect(waiting('ComputerUse').actionLabel).toBe('Open to handle')
  const team = taskActivityData(host, sessions, [{ id: 'one', activityState: 'waiting', decision: 'team_plan', preview: 'Team is ready, awaiting your confirmation' }], true, 100)!
  expect(team).toMatchObject({ status: 'waiting', detail: 'Team is ready, awaiting your confirmation', actionLabel: 'View and configure' })
  expect(team.allowUrl).toBeUndefined()
})

test('running work exposes the real start time for a live timer and never a fake step', () => {
  const running = taskActivityData(
    host,
    sessions,
    [
      { id: 'one', activityState: 'running', startedAt: 5_000 },
      { id: 'two', activityState: 'running' },
    ],
    true,
    100
  )!
  expect(running).toMatchObject({ status: 'running', startedAt: 5_000, activeCount: 2, detail: '' })
  expect(running.label).toBeUndefined()
  expect(JSON.stringify(running)).not.toContain('steps')
  expect(
    taskActivityData(host, sessions, [{ id: 'one', activityState: 'running', startedAt: NaN }], true, 100)
      ?.startedAt
  ).toBeUndefined()
})

test('finished outcomes report success with real duration, errors plainly, and never synthesize success', () => {
  const finished = finishedActivities(
    host,
    sessions,
    [
      { id: 'one', activityState: 'idle', terminalOutcome: 'completed', startedAt: 1_000, completedAt: 1_083_000 },
      { id: 'two', activityState: 'failed', terminalOutcome: 'failed' },
      { id: 'one', activityState: 'running' },
    ],
    2_000_000
  )
  expect(finished).toEqual([
    {
      props: {
        hostId: 'host-a',
        sessionId: 'one',
        hostName: 'Work Mac',
        title: 'Real task',
        detail: '',
        status: 'completed',
        activeCount: 1,
        summary: 'Done · took 18:02',
        openUrl: activityUrl('host-a', 'one'),
      },
      dismissAt: 1_083_000 + FINISHED_ACTIVITY_MS,
    },
    {
      props: expect.objectContaining({ sessionId: 'two', status: 'failed', summary: 'Stopped with error' }),
      dismissAt: 2_000_000 + FINISHED_ACTIVITY_MS,
    },
  ])
  expect(finished.some((item) => item.props.allowUrl || item.props.requestId)).toBe(false)
  for (const activity of [
    [{ id: 'one', activityState: 'idle' as const }],
    [{ id: 'one', activityState: 'idle' as const, terminalOutcome: 'stopped' as const, completedAt: 5 }],
    [{ id: 'one', activityState: 'idle' as const, terminalOutcome: 'completed' as const }],
    [{ id: 'gone', activityState: 'failed' as const }],
  ])
    expect(finishedActivities(host, sessions, activity, 100)).toEqual([])
  expect(
    finishedActivities(
      host,
      sessions,
      [{ id: 'one', activityState: 'review', terminalOutcome: 'completed', completedAt: 50 }],
      100
    )[0].props.summary
  ).toBe('Done')
})

const bashWaiting = {
  id: 'one',
  activityState: 'waiting' as const,
  requestId: 'req',
  toolName: 'Bash',
  preview: 'rm -rf /Users/secret/project',
}

test('default options keep the old behaviour: running work shows and the command is visible', () => {
  const running = [{ id: 'two', activityState: 'running' as const, startedAt: 1, preview: 'bun test' }]
  expect(taskActivityData(host, sessions, running, true, 100)).toEqual(
    taskActivityData(host, sessions, running, true, 100, { mode: 'running', showCommand: true })
  )
  expect(taskActivityData(host, sessions, running, true, 100)).toMatchObject({
    status: 'running',
    detail: 'bun test',
  })
  expect(taskActivityData(host, sessions, [bashWaiting], true, 100)?.detail).toBe(
    '$ rm -rf /Users/secret/project'
  )
})

test('decisions mode produces an activity only for waiting work', () => {
  const options = { mode: 'decisions' as const }
  const running = [{ id: 'two', activityState: 'running' as const, startedAt: 1 }]
  expect(taskActivityData(host, sessions, running, true, 100, options)).toBeNull()
  // running in mode the same data produces an activity, proving the null above comes from mode.
  expect(taskActivityData(host, sessions, running, true, 100)).not.toBeNull()
  // Waiting tasks rank ahead of running tasks, still shown, with the overall count.
  expect(
    taskActivityData(host, sessions, [...running, bashWaiting], true, 100, options)
  ).toMatchObject({ status: 'waiting', sessionId: 'one', activeCount: 2 })
  // When approvals are off in notifications (or in Do Not Disturb), decisions mode shows nothing.
  expect(taskActivityData(host, sessions, [...running, bashWaiting], false, 100, options)).toBeNull()
})

test('hiding the command removes command text from waiting and running props', () => {
  const options = { showCommand: false }
  const waiting = taskActivityData(host, sessions, [bashWaiting], true, 100, options)!
  expect(waiting).toMatchObject({ label: 'Wants to run a command', detail: 'Open the app to view the command' })
  expect(JSON.stringify(waiting)).not.toContain('rm -rf')
  expect(JSON.stringify(waiting)).not.toContain('secret')
  expect(JSON.stringify(waiting)).not.toContain('$ ')
  // Allow/deny still work: only the command text is hidden.
  expect(waiting.allowUrl).toBeDefined()

  const running = taskActivityData(
    host,
    sessions,
    [{ id: 'two', activityState: 'running', startedAt: 1, preview: 'cat /Users/secret/.env' }],
    true,
    100,
    options
  )!
  expect(running.detail).toBe('')
  expect(JSON.stringify(running)).not.toContain('secret')

  // The stale version after the connection is lost reuses the already redacted content.
  expect(JSON.stringify(staleActivityProps(waiting))).not.toContain('rm -rf')
  // Questions are not commands, so the question is still shown.
  expect(
    taskActivityData(
      host,
      sessions,
      [{ id: 'one', activityState: 'waiting', requestId: 'r', toolName: 'AskUserQuestion', preview: 'How should old fields be handled?' }],
      true,
      100,
      options
    )?.detail
  ).toBe('How should old fields be handled?')
})

test('finished activity props never carry command text regardless of the setting', () => {
  const activity = [
    {
      id: 'one',
      activityState: 'idle' as const,
      terminalOutcome: 'completed' as const,
      startedAt: 1_000,
      completedAt: 2_000,
      preview: 'rm -rf /Users/secret/project',
    },
    { id: 'two', activityState: 'failed' as const, terminalOutcome: 'failed' as const, preview: 'cat /Users/secret/.env' },
  ]
  const finished = finishedActivities(host, sessions, activity, 10_000)
  expect(finished).toHaveLength(2)
  expect(JSON.stringify(finished)).not.toContain('secret')
  expect(finished.every((item) => item.props.detail === '')).toBe(true)
})
