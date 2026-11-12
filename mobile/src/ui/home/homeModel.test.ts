import { expect, test } from 'bun:test'
import type { DashboardRow, MobileActivity } from '../../core/dashboard'
import type { ScheduledTask } from '../../core/operations'
import type { Session } from '../../core/types'
import {
  approvalPreview,
  canStartTask,
  clockLabel,
  decisionAction,
  decisionKind,
  highlightParts,
  hostAddress,
  hostCheckBadge,
  hostCheckLine,
  credentialHostCheck,
  hostLink,
  hostStatusLine,
  inProject,
  matchesQuery,
  nextCronRun,
  outcomeLine,
  pendingWhileOffline,
  planPreview,
  projectOf,
  projectsOf,
  scheduleSummary,
  settledOutcome,
  stalledLabel,
} from './homeModel'

test('a local credential read failure does not offer re-pairing as authorization recovery', () => {
  const host = { id: 'fixture', name: 'Fixture', url: 'https://fixture.invalid', auth: 'remote' as const }
  expect(hostLink({ host, fresh: false, failure: null, credentialError: 'Local read failed', credentialIssue: 'unavailable' })).toBe('failed')
  expect(credentialHostCheck('Local read failed', 'unavailable')).toEqual({ state: 'failed', message: 'Local read failed' })
  expect(hostCheckLine(host, { state: 'failed', message: 'Local read failed' }, Date.now())).toBe('Local read failed')
  expect(credentialHostCheck('Credentials not found', 'missing').state).toBe('unauthorized')
})

const session = (
  id: string,
  workDir: string | null = '/Users/me/cc-haha',
  extra: Partial<Session> = {}
): Session => ({
  id,
  title: id,
  createdAt: '2026-10-24T10:00:00',
  modifiedAt: '2026-10-24T10:00:00',
  messageCount: 2,
  projectPath: workDir ?? '',
  workDir,
  workDirExists: true,
  ...extra,
})
const row = (s: Session, activity?: MobileActivity): DashboardRow => ({
  session: s,
  activity,
})
const waiting = (extra: Partial<MobileActivity>): MobileActivity => ({
  id: 'x',
  activityState: 'waiting',
  ...extra,
})

test('projects group worktree sessions under their repository and keep recency order', () => {
  const rows = [
    row(session('a', '/Users/me/porthole/')),
    row(
      session('b', '/Users/me/cc-haha/.claude/worktrees/fix-ws', {
        projectRoot: '/Users/me/cc-haha',
      })
    ),
    row(session('c', '/Users/me/cc-haha')),
    row(session('d', null)),
  ]
  expect(projectOf(rows[0]!.session)).toEqual({
    key: '/Users/me/porthole',
    name: 'porthole',
    dir: '/Users/me/porthole',
  })
  expect(projectOf(rows[3]!.session)).toBeNull()
  expect(projectsOf(rows).map((p) => [p.name, p.count])).toEqual([
    ['porthole', 1],
    ['cc-haha', 2],
  ])
  expect(inProject(rows[1]!, '/Users/me/cc-haha')).toBe(true)
  expect(inProject(rows[0]!, '/Users/me/cc-haha')).toBe(false)
  expect(inProject(rows[3]!, null)).toBe(true)
})

test('only real tool approvals get inline allow/deny; questions, plans and computer use open the chat', () => {
  expect(decisionKind(waiting({ requestId: 'r', toolName: 'Bash' }))).toBe('approval')
  expect(decisionKind(waiting({ requestId: 'r', toolName: 'Edit' }))).toBe('approval')
  expect(decisionKind(waiting({ toolName: 'Bash' }))).toBe('other')
  expect(decisionKind(waiting({ requestId: 'r', toolName: 'ComputerUse' }))).toBe('other')
  expect(decisionKind(waiting({ requestId: 'r', toolName: 'AskUserQuestion' }))).toBe('question')
  expect(decisionKind(waiting({ requestId: 'r', toolName: 'ExitPlanMode' }))).toBe('plan')
  expect(decisionKind(undefined)).toBe('other')
})

test('decision phrases name what the agent wants to do', () => {
  expect(decisionAction(waiting({ requestId: 'r', toolName: 'Bash' }))).toBe('Wants to run a command')
  expect(decisionAction(waiting({ requestId: 'r', toolName: 'Write' }))).toBe('Wants to edit files')
  expect(decisionAction(waiting({ requestId: 'r', toolName: 'WebFetch' }))).toBe('Wants to visit a web page')
  expect(decisionAction(waiting({ requestId: 'r', toolName: 'ComputerUse' }))).toBe('Wants to use the computer')
  expect(
    decisionAction(waiting({ requestId: 'r', toolName: 'mcp__github__create_issue' }))
  ).toBe('Wants to use github · create_issue')
  expect(decisionAction(waiting({ toolName: 'AskUserQuestion' }))).toBe('Asking you')
  expect(decisionAction(waiting({ toolName: 'ExitPlanMode' }))).toBe('Plan is ready, waiting for your confirmation')
  expect(decisionAction(waiting({}))).toBe('Needs your decision')
  expect(pendingWhileOffline(waiting({ requestId: 'r', toolName: 'Bash' }))).toBe(
    'Waiting for your approval · can be handled once connected'
  )
  expect(pendingWhileOffline(waiting({ toolName: 'AskUserQuestion' }))).toBe(
    'Waiting for your answer · can be handled once connected'
  )
})

test('server placeholders never render as a command or a plan', () => {
  expect(
    approvalPreview(waiting({ toolName: 'Bash', preview: 'bun test src/core' }))
  ).toBe('$ bun test src/core')
  for (const preview of ['Waiting for tool permission', 'Waiting for computer control permission', 'Waiting for your answer', 'Needs your decision', '等待工具权限确认', '等待电脑操作权限确认']) {
    expect(approvalPreview(waiting({ toolName: 'Edit', preview }))).toBe('')
  }
  // Older desktop servers still send the Chinese placeholders.
  expect(planPreview(waiting({ toolName: 'ExitPlanMode', preview: 'Plan awaiting confirmation' }))).toBeNull()
  expect(planPreview(waiting({ toolName: 'ExitPlanMode', preview: '计划等待确认' }))).toBeNull()
  expect(
    planPreview(
      waiting({
        toolName: 'ExitPlanMode',
        preview:
          '# Title\n\n1. Tap the card to open details\n   `src/app/x.tsx`\n2. Add edit time\n3. Step three\n4. Step four',
      })
    )
  ).toEqual({ lines: ['1. Tap the card to open details', '2. Add edit time'], more: 2 })
})

test('settled rows separate completion, failure, stop, review and unknown history', () => {
  expect(settledOutcome(undefined)).toBe('unknown')
  expect(settledOutcome({ id: 'x', activityState: 'idle' })).toBe('unknown')
  expect(
    settledOutcome({ id: 'x', activityState: 'idle', terminalOutcome: 'completed' })
  ).toBe('done')
  expect(settledOutcome({ id: 'x', activityState: 'failed' })).toBe('failed')
  expect(
    settledOutcome({ id: 'x', activityState: 'idle', terminalOutcome: 'failed' })
  ).toBe('failed')
  expect(
    settledOutcome({ id: 'x', activityState: 'idle', terminalOutcome: 'stopped' })
  ).toBe('stopped')
  expect(settledOutcome({ id: 'x', activityState: 'review' })).toBe('review')
  expect(outcomeLine('done', 'cc-haha')).toBe('cc-haha · Done')
  expect(outcomeLine('failed', 'desktop')).toBe('Stopped with error · desktop')
  expect(outcomeLine('stopped', 'porthole')).toBe('You stopped · porthole')
  expect(outcomeLine('review', 'porthole')).toBe('porthole · Done · Unviewed')
  expect(outcomeLine('unknown', 'porthole')).toBe('porthole')
  expect(outcomeLine('failed', null)).toBe('Stopped with error')
})

test('stalled rows count minutes since the last real progress', () => {
  const now = new Date('2026-10-24T10:30:00').getTime()
  expect(stalledLabel({ id: 'x', activityState: 'running', lastProgressAt: now - 6 * 60000 }, now)).toBe(
    '6 min without progress'
  )
  expect(stalledLabel({ id: 'x', activityState: 'running', lastProgressAt: now - 125 * 60000 }, now)).toBe(
    '2 h without progress'
  )
  expect(stalledLabel({ id: 'x', activityState: 'running' }, now)).toBe('No progress for now')
})

test('search matches title or project, highlights every occurrence and ignores case', () => {
  const r = row(session('Fix duplicate messages after WebSocket reconnect', '/Users/me/Porthole'))
  expect(matchesQuery(r, 'Reconnect')).toBe(true)
  expect(matchesQuery(r, 'porthole')).toBe(true)
  expect(matchesQuery(r, 'desktop')).toBe(false)
  expect(matchesQuery(r, '  ')).toBe(true)
  expect(highlightParts('Disconnect, then connect', 'connect')).toEqual([
    { text: 'Dis', match: false },
    { text: 'connect', match: true },
    { text: ', then ', match: false },
    { text: 'connect', match: true },
  ])
  expect(highlightParts('WebSocket', 'socket')).toEqual([
    { text: 'Web', match: false },
    { text: 'Socket', match: true },
  ])
  expect(highlightParts('abc', '')).toEqual([{ text: 'abc', match: false }])
})

test('host link: staleness alone never blocks a new task; offline, revoked and missing hosts do', () => {
  const host = { id: 'h', name: 'Mac', url: 'http://192.168.1.10:3456', auth: 'lan' as const }
  expect(hostLink({ host: null, fresh: false, failure: null })).toBe('none')
  expect(hostLink({ host, fresh: false, failure: null })).toBe('connecting')
  expect(hostLink({ host, fresh: true, failure: null })).toBe('online')
  expect(hostLink({ host, fresh: false, failure: 'offline' })).toBe('offline')
  expect(hostLink({ host, fresh: false, failure: null, credentialError: 'Credentials expired' })).toBe(
    'unauthorized'
  )
  expect(canStartTask('connecting')).toBe(true)
  expect(canStartTask('slow')).toBe(true)
  expect(canStartTask('failed')).toBe(true)
  expect(canStartTask('online')).toBe(true)
  expect(canStartTask('offline')).toBe(false)
  expect(canStartTask('unauthorized')).toBe(false)
  expect(canStartTask('none')).toBe(false)
  expect(hostAddress(host)).toBe('LAN · 192.168.1.10:3456')
  expect(hostAddress({ auth: 'remote', url: 'https://mac.example.com' })).toBe('Public · mac.example.com')
})

test('status line names the network when online and the last sync when offline', () => {
  const now = new Date('2026-10-24T10:30:00').getTime()
  expect(hostStatusLine('online', { auth: 'lan' }, now, now)).toEqual({
    text: 'Online · LAN',
    tone: 'ok',
  })
  expect(hostStatusLine('online', { auth: 'remote' }, now, now).text).toBe('Online · Public')
  expect(hostStatusLine('offline', { auth: 'lan' }, now - 4 * 60000, now)).toEqual({
    text: 'Offline · last synced 4 minutes ago',
    tone: 'faint',
  })
  expect(hostStatusLine('offline', { auth: 'lan' }, undefined, now).text).toBe('Offline')
  expect(hostStatusLine('connecting', { auth: 'lan' }, undefined, now).text).toBe('Connecting…')
  expect(hostStatusLine('unauthorized', { auth: 'lan' }, undefined, now).tone).toBe('err')
})

test('other hosts: reuse the connectivity check wording and surface pending decisions', () => {
  const now = new Date('2026-10-24T10:30:00').getTime()
  expect(hostCheckLine({ auth: 'lan' }, { state: 'online' }, now)).toBe('LAN · online')
  expect(
    hostCheckLine(
      { auth: 'remote' },
      { state: 'online', checkedAt: now, expiresAt: now + 22.5 * 86400000 },
      now
    )
  ).toBe('Public · authorization expires in 23 days')
  expect(
    hostCheckLine({ auth: 'remote' }, { state: 'online', checkedAt: now, expiresAt: now + 3600000 }, now)
  ).toBe('Public · authorization expires in 1 day')
  expect(
    hostCheckLine({ auth: 'remote' }, { state: 'online', checkedAt: now, expiresAt: now }, now)
  ).toBe('Public · authorization expires in less than 1 day')
  expect(hostCheckLine({ auth: 'remote' }, { state: 'online' }, now)).toBe('Public · online')
  expect(
    hostCheckLine(
      { auth: 'lan' },
      { state: 'offline', lastOnlineAt: new Date('2026-10-23T23:10:00').getTime() },
      now
    )
  ).toBe('Offline · last online yesterday 23:10')
  expect(hostCheckLine({ auth: 'lan' }, { state: 'offline' }, now)).toBe('Offline · unreachable for now')
  expect(hostCheckLine({ auth: 'lan' }, { state: 'unauthorized' }, now)).toBe('Authorization expired · please reconnect')
  expect(hostCheckLine({ auth: 'lan' }, { state: 'checking' }, now)).toBe('Checking connection…')
  expect(hostCheckBadge({ state: 'online', waiting: 1, running: 2 })).toEqual({
    text: '1 waiting for you',
    tone: 'attn',
  })
  expect(hostCheckBadge({ state: 'online', running: 2 })).toEqual({ text: '2 in progress', tone: 'ink3' })
  expect(hostCheckBadge({ state: 'offline', waiting: 1 })).toBeNull()
  expect(clockLabel(new Date('2026-10-24T08:05:00').getTime(), now)).toBe('08:05')
  expect(clockLabel(new Date('2026-10-21T08:05:00').getTime(), now)).toBe('10/21 08:05')
})

test('next cron run handles daily, weekday and single-weekday schedules only', () => {
  // 2026-10-24 is a Saturday.
  const saturday = new Date('2026-10-24T10:30:00')
  expect(nextCronRun('0 18 * * *', saturday)).toEqual(new Date('2026-10-24T18:00:00'))
  expect(nextCronRun('0 9 * * *', saturday)).toEqual(new Date('2026-10-25T09:00:00'))
  expect(nextCronRun('30 8 * * 1-5', saturday)).toEqual(new Date('2026-10-26T08:30:00'))
  expect(nextCronRun('0 10 * * 1', saturday)).toEqual(new Date('2026-10-26T10:00:00'))
  expect(nextCronRun('0 10 * * 0', saturday)).toEqual(new Date('2026-10-25T10:00:00'))
  expect(nextCronRun('0 10 * * 7', saturday)).toEqual(new Date('2026-10-25T10:00:00'))
  expect(nextCronRun('30 10 * * 6', saturday)).toEqual(new Date('2026-10-31T10:30:00'))
  expect(nextCronRun('*/5 * * * *', saturday)).toBeNull()
  expect(nextCronRun('0 9 1 * *', saturday)).toBeNull()
  expect(nextCronRun('0 25 * * *', saturday)).toBeNull()
  expect(nextCronRun('nonsense', saturday)).toBeNull()
})

test('schedule summary counts enabled tasks and shows the next time only when every one is computable', () => {
  const task = (cron: string, enabled?: boolean): ScheduledTask => ({
    id: cron,
    cron,
    prompt: 'p',
    createdAt: 0,
    ...(enabled === undefined ? {} : { enabled }),
  })
  const saturday = new Date('2026-10-24T10:30:00')
  expect(scheduleSummary([], saturday)).toBe('Not set up')
  expect(scheduleSummary([task('0 18 * * *', false)], saturday)).toBe('All paused')
  expect(
    scheduleSummary(
      [task('0 18 * * *'), task('0 9 * * *', true), task('0 7 * * *', false)],
      saturday
    )
  ).toBe('2 enabled · next 18:00')
  expect(scheduleSummary([task('0 9 * * *')], saturday)).toBe('1 enabled · next tomorrow 09:00')
  expect(scheduleSummary([task('30 8 * * 1-5')], saturday)).toBe('1 enabled · next Mon 08:30')
  expect(scheduleSummary([task('0 18 * * *'), task('*/10 * * * *')], saturday)).toBe('2 enabled')
})

test('schedule summary uses explicit one-time and server-projected occurrences', () => {
  const now = new Date('2026-10-24T10:30:00')
  const next = new Date('2026-10-24T18:00:00')
  const task: ScheduledTask = { id: 'once', prompt: 'check', cron: '', createdAt: 0, schedule: { kind: 'once', runAt: next.toISOString(), timeZone: 'Asia/Shanghai' } }
  expect(scheduleSummary([task], now)).toBe('1 enabled · next 18:00')
  expect(scheduleSummary([{ ...task, enabled: false, scheduleState: 'completed' }], now)).toBe('All done')
  expect(scheduleSummary([{ ...task, cron: '0 9 * * *', schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'America/New_York' }, nextRunAt: next.getTime() }], now)).toBe('1 enabled · next 18:00')
})

test('search also matches the full working directory, like the previous home', () => {
  const r = row(session('Prepare release notes', '/Users/me/code/cc-haha/mobile'))
  expect(matchesQuery(r, 'code/cc-haha')).toBe(true)
  expect(matchesQuery(r, 'mobile')).toBe(true)
  expect(matchesQuery(r, 'Unrelated')).toBe(false)
})

test('a team plan waiting for approval is its own decision, opened from the session', () => {
  const team: MobileActivity = { id: 's', activityState: 'waiting', decision: 'team_plan', preview: 'New members awaiting your confirmation' }
  expect(decisionKind(team)).toBe('team')
  expect(decisionAction(team)).toBe('New members awaiting your confirmation')
  expect(decisionAction({ ...team, preview: undefined })).toBe('Team is ready, awaiting your confirmation')
  // Never mistaken for a tool approval the list could allow or deny.
  expect(decisionKind({ ...team, requestId: 'r', toolName: 'Bash' })).toBe('team')
})
