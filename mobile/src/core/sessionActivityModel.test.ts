import { describe, expect, test } from 'bun:test'
import { ApiClient } from './client'
import type { BackgroundTask } from './operations'
import {
  ACTIVE_POLL_MS,
  ActivityStore,
  STOP_TIMEOUT_MS,
  TEAM_RECHECK_MS,
  capsuleVisible,
  commandRows,
  createActivityFetcher,
  deriveActivity,
  memberMark,
  teamMembersAllStopped,
  planTasks,
  pollDelay,
  sectionSummaries,
  subagentRows,
  subagentStats,
  teamModel,
  type ActivityConfig,
  type ActivityFetchResult,
  type ActivityFetcher,
} from './sessionActivityModel'
import { runKey, taskKey } from './subagentLive'
import type { ClientMessage, SubagentLive } from './types'
import type { TaskInfo, TeamMember, TeamWorkbenchSessionTimeline } from '../ui/activity/activityData'

const info = (patch: Partial<TaskInfo>): TaskInfo => ({
  id: '1',
  subject: 'Tasks',
  description: '',
  status: 'pending',
  blocks: [],
  blockedBy: [],
  taskListId: 's',
  ...patch,
})
const bg = (patch: Partial<BackgroundTask>): BackgroundTask => ({
  taskId: 't',
  status: 'running',
  taskType: 'local_bash',
  description: 'bun run bench',
  ...patch,
})
const agent = (patch: Partial<BackgroundTask> = {}) =>
  bg({ taskId: 'a1', taskType: 'local_agent', toolUseId: 'tool-a1', description: 'explorer', ...patch })
const member = (patch: Partial<TeamMember>): TeamMember => ({
  agentId: 'builder@team',
  name: 'builder',
  status: 'running',
  ...patch,
})
const timeline = (members: TeamMember[], tasks: TaskInfo[] = [], patch: Partial<TeamWorkbenchSessionTimeline> = {}, deletedAt?: string): TeamWorkbenchSessionTimeline => ({
  sessionId: 's',
  teamName: 'team',
  incarnationId: 'i1',
  source: 'live',
  snapshots: [
    {
      version: '1',
      generatedAt: '',
      ...(deletedAt ? { deletedAt } : {}),
      tasks,
      messages: [],
      team: { name: 'team', incarnationId: 'i1', leadSessionId: 's', leadAgentId: 'lead@team', createdAt: 1, members },
    },
  ],
  ...patch,
})
const data = (patch: Partial<Parameters<typeof deriveActivity>[0]> = {}) => ({
  tasks: [],
  team: null,
  background: [],
  stopping: {},
  ...patch,
})

describe('Task list', () => {
  const tasks = [
    info({ id: '1', subject: 'Read the existing pairing flow', status: 'completed' }),
    info({ id: '2', subject: 'Split the scan page and connection validation', status: 'in_progress', activeForm: 'Splitting the scan page' }),
    info({ id: '3', subject: 'Improve mobile Composer' }),
    info({ id: '4', subject: 'Regression check', blockedBy: ['2'], owner: 'reviewer' }),
  ]
  test('Four states: done, in progress (with activeForm), not started, waiting on dependencies (with owner)', () => {
    expect(planTasks(tasks)).toEqual([
      { id: '1', title: 'Read the existing pairing flow', state: 'done' },
      { id: '2', title: 'Split the scan page and connection validation', state: 'active', detail: 'Splitting the scan page' },
      { id: '3', title: 'Improve mobile Composer', state: 'todo' },
      { id: '4', title: 'Regression check', state: 'waiting', owner: 'reviewer' },
    ])
  })
  test('Once dependencies are done it returns to not started; in progress without activeForm does not make up a description', () => {
    const rows = planTasks([
      info({ id: '1', status: 'completed' }),
      info({ id: '2', blockedBy: ['1'] }),
      info({ id: '3', status: 'in_progress', activeForm: '  ' }),
    ])
    expect(rows[1]?.state).toBe('todo')
    expect(rows[2]).not.toHaveProperty('detail')
  })
  test('Progress: done/total; active uses the activeForm of the in-progress task, defaulting to the title', () => {
    expect(deriveActivity(data({ tasks })).progress).toEqual({ done: 1, total: 4, active: 'Splitting the scan page' })
    const bare = [info({ status: 'in_progress', subject: 'Working' })]
    expect(deriveActivity(data({ tasks: bare })).progress.active).toBe('Working')
    expect(deriveActivity(data()).progress).toEqual({ done: 0, total: 0 })
  })
  test('While the team runs, progress follows the team board and tasks are not listed separately (they hang under members)', () => {
    const team = timeline([member({})], [info({ id: 'x', status: 'completed' }), info({ id: 'y' })])
    expect(deriveActivity(data({ team })).progress).toMatchObject({ done: 1, total: 2 })
    const model = deriveActivity(data({ team, tasks }))
    expect(model.progress).toMatchObject({ done: 1, total: 2 })
    expect(model.tasks).toEqual([])
  })
  test('Team archived: back to the session’s own list', () => {
    const archived = timeline([member({})], [info({ id: 'x' })], { source: 'archive' })
    const model = deriveActivity(data({ team: archived, tasks }))
    expect(model.progress.total).toBe(4)
    expect(model.tasks).toHaveLength(4)
    expect(deriveActivity(data({ team: archived })).progress.total).toBe(1)
  })
})

describe('Subagents and background commands', () => {
  const live: Record<string, SubagentLive> = {
    [runKey('a1')]: {
      reads: ['/a', '/b', '/c'],
      steps: [
        { toolUseId: '1', toolName: 'Read', input: { file_path: '/repo/src/a.ts' }, done: true },
        { toolUseId: '2', toolName: 'Read', input: { file_path: '/repo/src/b.ts' }, done: true },
        { toolUseId: '3', toolName: 'Read', input: { file_path: '/repo/src/c.ts' }, done: false },
      ],
    },
    [taskKey('a1')]: { reads: [], steps: [], toolUses: 8 },
  }
  test('Running subagent: files read, last two steps (relative paths), current step unfinished', () => {
    const [row] = subagentRows([agent({ startedAt: '2026-10-25T10:00:00.000Z' })], live, {}, '/repo')
    expect(row).toMatchObject({ id: 'a1', title: 'explorer', status: 'running', stats: 'Read 3 files' })
    expect(row?.startedAt).toBe(Date.parse('2026-10-25T10:00:00.000Z'))
    expect(row?.steps).toEqual([
      { verb: 'Read', object: 'src/b.ts', mono: true, done: true, error: false },
      { verb: 'Read', object: 'src/c.ts', mono: true, done: false, error: false },
    ])
  })
  test('Without live data do not show steps or stats, let alone make them up', () => {
    const [row] = subagentRows([agent()], undefined, {})
    expect(row?.steps).toEqual([])
    expect(row?.stats).toBeUndefined()
  })
  test('Finished cards show the tool call count, not recent steps', () => {
    const [row] = subagentRows([agent({ status: 'completed' })], live, {})
    expect(row).toMatchObject({ stats: '8 tool calls', steps: [] })
  })
  test('Stats text: while running prefer file count, then call count; after finishing prefer call count', () => {
    expect(subagentStats('running', { reads: 2, toolUses: 9 })).toBe('Read 2 files')
    expect(subagentStats('running', { reads: 0, toolUses: 9 })).toBe('9 tool calls')
    expect(subagentStats('completed', { reads: 2, toolUses: 9 })).toBe('9 tool calls')
    expect(subagentStats('completed', { reads: 2 })).toBe('Read 2 files')
    expect(subagentStats('running', { reads: 0 })).toBeUndefined()
    expect(subagentStats('running', null)).toBeUndefined()
  })
  test('Running ones first, same state keeps original order; subagents and commands grouped separately', () => {
    const rows = [
      agent({ taskId: 'done', status: 'completed' }),
      agent({ taskId: 'run1' }),
      bg({ taskId: 'cmd-done', status: 'completed' }),
      agent({ taskId: 'run2' }),
      bg({ taskId: 'cmd-run' }),
    ]
    expect(subagentRows(rows, undefined, {}).map((row) => row.id)).toEqual(['run1', 'run2', 'done'])
    expect(commandRows(rows, {}).map((row) => row.id)).toEqual(['cmd-run', 'cmd-done'])
  })
  test('Command rows show the last output line; stopping comes from a local request or a computer flag', () => {
    const [row] = commandRows([bg({ result: 'a\nFixture: sample 1 / 20 …\n\n' })], { t: true })
    expect(row).toMatchObject({ command: 'bun run bench', lastLine: 'Fixture: sample 1 / 20 …', stopping: true })
    expect(commandRows([bg({ stopping: true })], {})[0]?.stopping).toBe(true)
    expect(commandRows([bg({})], {})[0]?.stopping).toBe(false)
  })
})

describe('runningCount Counting rule', () => {
  test('Count only running subagents and background commands; done, stopped, failed and team members do not count', () => {
    const background = [
      agent({ taskId: 'a1' }),
      agent({ taskId: 'a2', status: 'completed' }),
      bg({ taskId: 'c1' }),
      bg({ taskId: 'c2', status: 'failed' }),
      bg({ taskId: 'c3', status: 'stopped' }),
    ]
    const team = timeline([member({ activity: 'active' })])
    const model = deriveActivity(data({ background, team }))
    expect(model.runningCount).toBe(2)
    // The capsule badge and sheet title use this one number: the "running" counts in the group summaries add up to it.
    const summaries = sectionSummaries(model)
    const running = (text: string) => Number(/(\d+) running/.exec(text)?.[1] ?? 0)
    expect(running(summaries.subagents) + running(summaries.commands)).toBe(model.runningCount)
  })
  test('tone: attention when an approval is pending, otherwise run', () => {
    expect(deriveActivity(data(), { pendingApprovals: 1 }).tone).toBe('attention')
    expect(deriveActivity(data(), { pendingApprovals: 0 }).tone).toBe('run')
    expect(deriveActivity(data()).tone).toBe('run')
  })
})

describe('Capsule visibility', () => {
  const progress = (done: number, total: number) => ({ done, total })
  test('No tasks and nothing running: hidden', () => {
    expect(capsuleVisible({ runningCount: 0, progress: progress(0, 0), turnActive: true })).toBe(false)
    expect(deriveActivity(data(), { turnActive: true }).capsuleVisible).toBe(false)
  })
  test('Something running in background: shown, even without a list', () => {
    expect(capsuleVisible({ runningCount: 1, progress: progress(0, 0), turnActive: false })).toBe(true)
  })
  test('List all done and this turn ended: hidden; turn still running or unfinished items: shown', () => {
    expect(capsuleVisible({ runningCount: 0, progress: progress(3, 3), turnActive: false })).toBe(false)
    expect(capsuleVisible({ runningCount: 0, progress: progress(3, 3), turnActive: true })).toBe(true)
    expect(capsuleVisible({ runningCount: 0, progress: progress(2, 3), turnActive: false })).toBe(true)
  })
  test('active: spin only when this turn is running or something is running', () => {
    expect(deriveActivity(data({ tasks: [info({})] })).active).toBe(false)
    expect(deriveActivity(data({ tasks: [info({})] }), { turnActive: true }).active).toBe(true)
    expect(deriveActivity(data({ background: [bg({})] })).active).toBe(true)
  })
  test('Lead turn ended while members are still working: the capsule still shows and spins', () => {
    const working = deriveActivity(data({ team: timeline([member({ activity: 'active' })]) }))
    expect(working).toMatchObject({ active: true, capsuleVisible: true, runningCount: 0 })
    // Only the lead itself running does not count: that is the session itself, handled by turnActive.
    const leadOnly = deriveActivity(data({ team: timeline([member({ agentId: 'lead@team', name: 'team-lead', activity: 'active' })]) }))
    expect(leadOnly).toMatchObject({ active: false, capsuleVisible: false })
  })
})

describe('Team', () => {
  test('State and description of lead, working, waiting on dependencies and idle', () => {
    const tasks = [
      info({ id: '1', owner: 'builder', status: 'in_progress', subject: 'Edit connectHost', activeForm: 'Edit connectHost.ts' }),
      info({ id: '2', owner: 'reviewer', blockedBy: ['1'], subject: 'Review' }),
    ]
    const team = teamModel(
      timeline(
        [
          member({ agentId: 'lead@team', name: 'team-lead', activity: 'active' }),
          member({ activity: 'active' }),
          member({ agentId: 'reviewer@team', name: 'reviewer', activity: 'idle' }),
          member({ agentId: 'qa@team', name: 'qa', activity: 'idle' }),
        ],
        tasks
      )
    )
    expect(team?.members.map((row) => [row.name, row.state, row.detail, row.tone])).toEqual([
      ['Lead', 'Working', undefined, 'run'],
      ['builder', 'Working', 'Edit connectHost.ts', 'run'],
      ['reviewer', 'Waiting on dependencies', undefined, 'wait'],
      ['qa', 'Idle', undefined, 'idle'],
    ])
    expect(team?.summary).toBe('team · 0/2 done')
  })
  test('Tasks follow their owner: under a member are the board tasks it claimed; under the lead is the session’s own list', () => {
    const board = [
      info({ id: '1', owner: 'backend-dev', status: 'completed', subject: 'Design the data model' }),
      info({ id: '2', owner: 'backend-dev@team', status: 'in_progress', subject: 'Implement CRUD API', activeForm: 'Write routes' }),
      info({ id: '3', owner: 'frontend-dev', status: 'completed', subject: 'Scaffold the page' }),
      info({ id: '4', owner: 'frontend-dev', blockedBy: ['2', '3'], subject: 'Wire up the API' }),
      info({ id: '5', subject: 'Add README' }),
      info({ id: '6', owner: 'someone-gone', subject: 'Old member’s task' }),
    ]
    const own = [info({ id: '1', subject: 'Split the team plan', status: 'completed' })]
    const team = teamModel(
      timeline(
        [
          member({ agentId: 'frontend-dev@team', name: 'frontend-dev', activity: 'idle', model: 'deepseek-v4.1-flash' }),
          member({ agentId: 'backend-dev@team', name: 'backend-dev', activity: 'active' }),
          member({ agentId: 'lead@team', name: 'team-lead', activity: 'idle' }),
        ],
        board
      ),
      own
    )!
    // Lead goes first; under it is its own list (no board numbers, to avoid confusion with #1).
    expect(team.members.map((row) => [row.name, row.mark, row.tasks.map((task) => task.ref ?? task.title)])).toEqual([
      ['Lead', 'L', ['Split the team plan']],
      ['frontend-dev', 'FD', ['3', '4']],
      ['backend-dev', 'BD', ['1', '2']],
    ])
    const frontend = team.members[1]!
    expect(frontend).toMatchObject({ model: 'deepseek-v4.1-flash', state: 'Waiting on dependencies', tone: 'wait' })
    // List only unfinished prerequisite tasks.
    expect(frontend.tasks[1]).toMatchObject({ key: 'team:4', state: 'waiting', waitingOn: ['2'] })
    expect(team.members[2]!.tasks[1]).toMatchObject({ state: 'active', detail: 'Write routes' })
    expect(team.unassigned.map((task) => task.ref)).toEqual(['5', '6'])
    expect(team.progress).toEqual({ done: 2, total: 6 })
    expect(team.summary).toBe('team · 2/6 done')
  })
  test('Member avatars use the initials of the first two words of the name, unique within the team', () => {
    expect(['backend-dev', 'qa_reviewer', 'reviewer', 'team lead', 'x'].map((name) => memberMark(name))).toEqual(['BD', 'QR', 'RE', 'TL', 'X'])
    expect(memberMark('reviewer', new Set(['RE']))).toBe('RV')
    const team = teamModel(timeline([member({ agentId: 'r1', name: 'researcher' }), member({ agentId: 'r2', name: 'reviewer' })]))
    expect(team?.members.map((row) => row.mark)).toEqual(['RE', 'RV'])
  })
  test('The group counts as stopped only when all members are stopped or exited; the lead does not count, and no roster does not count', () => {
    const team = (states: string[]) => ({ members: [{ lead: true, state: 'Working' }, ...states.map((state) => ({ lead: false, state }))] as never })
    expect(teamMembersAllStopped(team(['Stopped', 'Exited']))).toBe(true)
    expect(teamMembersAllStopped(team(['Stopped', 'Idle']))).toBe(false)
    expect(teamMembersAllStopped(team([]))).toBe(false)
    expect(teamMembersAllStopped(null)).toBe(false)
  })
  test('Member page: members can still be found (exited) after the team wraps up and is archived', () => {
    const archived = timeline([member({ activity: 'active' })], [info({ id: '1', owner: 'builder', status: 'completed' })], { source: 'archive' }, '2026-10-30T09:59:12Z')
    expect(teamModel(archived)).toBeNull()
    const team = teamModel(archived, [], { ended: true })
    expect(team?.members.map((row) => [row.name, row.state, row.tasks.map((task) => task.state)])).toEqual([['builder', 'Exited', ['done']]])
    expect(teamModel({ ...archived, snapshots: [] }, [], { ended: true })).toBeNull()
  })
  test('Archived, deleted and snapshot-less teams are not running', () => {
    expect(teamModel(null)).toBeNull()
    expect(teamModel(timeline([member({})], [], { source: 'archive' }))).toBeNull()
    expect(teamModel(timeline([member({})], [], {}, '2026-10-25T00:00:00Z'))).toBeNull()
    expect(teamModel({ ...timeline([]), snapshots: [] })).toBeNull()
  })
})

describe('Group summary', () => {
  test('One-liner for tasks, subagents and background commands', () => {
    const model = deriveActivity(
      data({
        tasks: [info({ id: '1', status: 'completed' }), info({ id: '2', status: 'in_progress' }), info({ id: '3' })],
        background: [agent({}), agent({ taskId: 'a2', status: 'completed' }), bg({}), bg({ taskId: 'c2', status: 'stopped' })],
      })
    )
    expect(sectionSummaries(model)).toMatchObject({
      tasks: '1/3 done · 1 in progress',
      subagents: '1 running · 1 done',
      commands: '1 running · 1 ended',
    })
  })
})

describe('Polling conditions', () => {
  const base = { enabled: true, visible: true, turnActive: false, backgroundIds: 0, running: 0, teamActive: false }
  test('No polling when idle; poll only while running, with background tasks, or team working', () => {
    expect(pollDelay(base)).toBeNull()
    expect(pollDelay({ ...base, turnActive: true })).toBe(ACTIVE_POLL_MS)
    expect(pollDelay({ ...base, backgroundIds: 2 })).toBe(ACTIVE_POLL_MS)
    expect(pollDelay({ ...base, running: 1 })).toBe(ACTIVE_POLL_MS)
    expect(pollDelay({ ...base, teamActive: true })).toBe(ACTIVE_POLL_MS)
  })
  test('Always stop when the page is hidden or disabled', () => {
    expect(pollDelay({ ...base, turnActive: true, visible: false })).toBeNull()
    expect(pollDelay({ ...base, turnActive: true, enabled: false })).toBeNull()
  })
  test('Active interval between 3 and 4 seconds', () => {
    expect(ACTIVE_POLL_MS).toBeGreaterThanOrEqual(3000)
    expect(ACTIVE_POLL_MS).toBeLessThanOrEqual(4000)
  })
})

/* ───────────── ActivityStore ───────────── */

class FakeTimers {
  now = 0
  #id = 0
  #timers = new Map<number, { at: number; callback: () => void }>()
  set = (callback: () => void, delay: number) => {
    const id = ++this.#id
    this.#timers.set(id, { at: this.now + delay, callback })
    return id
  }
  clear = (handle: unknown) => {
    this.#timers.delete(handle as number)
  }
  get pending() {
    return this.#timers.size
  }
  /** Advance time and run due timers; yield microtasks after each so async reads complete. */
  async advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      const next = [...this.#timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.#timers.delete(next[0])
      this.now = next[1].at
      next[1].callback()
      await settle()
    }
    this.now = end
  }
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const config = (patch: Partial<ActivityConfig> = {}): ActivityConfig => ({
  enabled: true,
  visible: true,
  turnActive: false,
  backgroundKey: '',
  ...patch,
})

function harness(initial: Partial<ActivityFetchResult> = {}) {
  const timers = new FakeTimers()
  const calls: { team: boolean }[] = []
  const sent: ClientMessage[] = []
  let result: ActivityFetchResult = { errors: [], tasks: [], team: null, background: [], ...initial }
  let gate: Promise<void> | null = null
  const fetch: ActivityFetcher = async (signal, options) => {
    calls.push(options)
    if (gate) await gate
    if (signal.aborted) throw new Error('aborted')
    return { ...result, ...(options.team ? {} : { team: undefined }) }
  }
  const store = new ActivityStore({
    fetch,
    send: (message) => (sent.push(message), true),
    timers,
    now: () => timers.now,
  })
  return {
    store,
    timers,
    calls,
    sent,
    set: (next: Partial<ActivityFetchResult>) => (result = { ...result, ...next }),
    hold() {
      let release!: () => void
      gate = new Promise<void>((resolve) => (release = resolve))
      return () => {
        gate = null
        release()
      }
    },
  }
}

describe('ActivityStore Polling', () => {
  test('Read once on enable; when idle (nothing running, no background) do not schedule another', async () => {
    const h = harness()
    h.store.configure(config())
    await settle()
    expect(h.calls).toHaveLength(1)
    expect(h.timers.pending).toBe(0)
    await h.timers.advance(60_000)
    expect(h.calls).toHaveLength(1)
    expect(h.store.getSnapshot().loaded).toBe(true)
  })

  test('Poll at intervals while running, stop after this turn ends', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true }))
    await settle()
    await h.timers.advance(ACTIVE_POLL_MS * 3)
    expect(h.calls).toHaveLength(4)
    h.store.configure(config({ turnActive: false }))
    await settle()
    // Read once more at the end to get the final state, then stop polling.
    const after = h.calls.length
    await h.timers.advance(60_000)
    expect(h.calls).toHaveLength(after)
  })

  test('Pause and cancel pending polls when the page is hidden; read immediately and resume on returning to foreground', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true }))
    await settle()
    expect(h.timers.pending).toBe(1)
    h.store.configure(config({ turnActive: true, visible: false }))
    expect(h.timers.pending).toBe(0)
    const paused = h.calls.length
    await h.timers.advance(60_000)
    expect(h.calls).toHaveLength(paused)
    h.store.configure(config({ turnActive: true, visible: true }))
    await settle()
    expect(h.calls).toHaveLength(paused + 1)
    expect(h.timers.pending).toBe(1)
  })

  test('Reread immediately when background task IDs change; keep polling while background tasks exist, stop when cleared', async () => {
    const h = harness({ background: [bg({})] })
    h.store.configure(config({ backgroundKey: 't' }))
    await settle()
    expect(h.calls).toHaveLength(1)
    expect(h.timers.pending).toBe(1)
    h.set({ background: [bg({ status: 'completed' })] })
    h.store.configure(config({ backgroundKey: '' }))
    await settle()
    expect(h.calls).toHaveLength(2)
    expect(h.timers.pending).toBe(0)
  })

  test('Config change during a read: merge into one follow-up read, no concurrency', async () => {
    const h = harness()
    const release = h.hold()
    h.store.configure(config({ turnActive: true }))
    h.store.configure(config({ turnActive: true, backgroundKey: 'x' }))
    h.store.configure(config({ turnActive: true, backgroundKey: 'x\ny' }))
    await settle()
    expect(h.calls).toHaveLength(1)
    release()
    await settle()
    expect(h.calls).toHaveLength(2)
  })

  test('Cancel in-flight reads on disable; late results are not written', async () => {
    const h = harness({ tasks: [info({})] })
    const release = h.hold()
    h.store.configure(config({ turnActive: true }))
    await settle()
    h.store.configure(config({ enabled: false }))
    release()
    await settle()
    expect(h.store.getSnapshot().loaded).toBe(false)
    expect(h.timers.pending).toBe(0)
    // Re-enabling later is not stuck on the old request's wrap-up state.
    h.store.configure(config({ turnActive: true }))
    await settle()
    expect(h.store.getSnapshot().tasks).toHaveLength(1)
  })

  test('After no team (null) wait a while before probing again; manual refresh probes immediately', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true }))
    await settle()
    expect(h.calls[0]?.team).toBe(true)
    await h.timers.advance(ACTIVE_POLL_MS)
    expect(h.calls[1]?.team).toBe(false)
    await h.timers.advance(TEAM_RECHECK_MS)
    expect(h.calls.some((call, index) => index > 1 && call.team)).toBe(true)
    const before = h.calls.length
    await h.store.refresh({ forceTeam: true })
    expect(h.calls[before]?.team).toBe(true)
  })

  test('When the team plan state changes (just approved) reread together with the team without waiting for the team probe interval', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true, teamPlanKey: 'p1:review_pending' }))
    await settle()
    await h.timers.advance(ACTIVE_POLL_MS)
    expect(h.calls.at(-1)?.team).toBe(false)
    const before = h.calls.length
    h.store.configure(config({ turnActive: true, teamPlanKey: 'p1:launching', teamLaunching: true }))
    await settle()
    expect(h.calls).toHaveLength(before + 1)
    expect(h.calls.at(-1)?.team).toBe(true)
  })

  test('Team launching: poll at intervals even with the lead idle, reading the team each time; normal once in place', async () => {
    const h = harness()
    h.store.configure(config({ teamPlanKey: 'p1:launching', teamLaunching: true }))
    await settle()
    await h.timers.advance(ACTIVE_POLL_MS * 2)
    expect(h.calls).toHaveLength(3)
    expect(h.calls.every((call) => call.team)).toBe(true)
    h.set({ team: timeline([member({ activity: 'active' })]) })
    h.store.configure(config({ teamPlanKey: 'p1:running' }))
    await settle()
    expect(h.store.getSnapshot().team).not.toBeNull()
    expect(h.timers.pending).toBe(1)
  })

  test('Plan changed while the page was hidden: the read on returning to foreground includes the team', async () => {
    const h = harness()
    h.store.configure(config({ turnActive: true, teamPlanKey: 'p1:review_pending' }))
    await settle()
    await h.timers.advance(ACTIVE_POLL_MS)
    h.store.configure(config({ turnActive: true, visible: false, teamPlanKey: 'p1:running' }))
    const before = h.calls.length
    h.store.configure(config({ turnActive: true, teamPlanKey: 'p1:running' }))
    await settle()
    expect(h.calls).toHaveLength(before + 1)
    expect(h.calls.at(-1)?.team).toBe(true)
  })

  test('Read every time while the team exists; keep old data and report on partial failure', async () => {
    const h = harness({ team: timeline([member({ activity: 'active' })]), tasks: [info({ subject: 'Old task' })] })
    h.store.configure(config())
    await settle()
    expect(h.timers.pending).toBe(1) // Someone in the team working: poll even when idle
    h.set({ errors: ['Tasks: offline'], tasks: undefined })
    await h.timers.advance(ACTIVE_POLL_MS)
    expect(h.calls.every((call) => call.team)).toBe(true)
    const snapshot = h.store.getSnapshot()
    expect(snapshot.tasks[0]?.subject).toBe('Old task')
    expect(snapshot.error).toBe('Tasks: offline')
  })

  test('Whole read fails: record the reason, mark loaded, do not throw', async () => {
    const timers = new FakeTimers()
    const store = new ActivityStore({
      fetch: async () => {
        throw new Error('Computer unreachable')
      },
      send: () => true,
      timers,
    })
    store.configure(config())
    await settle()
    expect(store.getSnapshot()).toMatchObject({ loaded: true, error: 'Computer unreachable' })
  })
})

describe('ActivityStore Re-enable', () => {
  test('When a canceled old read wraps up it does not treat the new read as finished', async () => {
    const timers = new FakeTimers()
    const gates: (() => void)[] = []
    let calls = 0
    const store = new ActivityStore({
      fetch: async () => {
        calls++
        await new Promise<void>((resolve) => gates.push(resolve))
        return { errors: [], tasks: [], team: null, background: [] }
      },
      send: () => true,
      timers,
    })
    store.configure(config({ turnActive: true }))
    await settle()
    store.configure(config({ enabled: false }))
    store.configure(config({ turnActive: true })) // Second read starts before the old one returns
    await settle()
    expect(calls).toBe(2)
    gates[0]!() // Old read wraps up
    await settle()
    store.configure(config({ turnActive: true, backgroundKey: 'x' })) // New read still in progress: can only merge, not run concurrently
    await settle()
    expect(calls).toBe(2)
    gates[1]!()
    await settle()
    expect(calls).toBe(3)
  })
})

describe('ActivityStore Stop', () => {
  const running = () => [agent({}), bg({ taskId: 'c1' }), bg({ taskId: 'c2', status: 'completed' })]
  async function ready() {
    const h = harness({ background: running() })
    h.store.configure(config({ backgroundKey: 'a1\nc1' }))
    await settle()
    return h
  }
  test('Single stop sends stop_background_task and marks it stopping', async () => {
    const h = await ready()
    expect(h.store.stopTask('c1')).toBe(true)
    expect(h.sent).toEqual([{ type: 'stop_background_task', taskId: 'c1' }])
    expect(h.store.getSnapshot().stopping).toEqual({ c1: true })
    expect(h.store.stopTask('c1')).toBe(true)
    expect(h.sent).toHaveLength(1) // Repeated taps do not send twice
  })
  test('Stop all only sends to subagents and commands still running', async () => {
    const h = await ready()
    h.store.stopAll()
    expect(h.sent.map((message) => (message as { taskId: string }).taskId).sort()).toEqual(['a1', 'c1'])
  })
  test('Tasks no longer running cannot be stopped', async () => {
    const h = await ready()
    h.store.stopTask('c2')
    h.store.stopTask('ghost')
    expect(h.sent).toEqual([])
  })
  test('Connection not ready: do not mark stopping, give a clear message', async () => {
    const timers = new FakeTimers()
    const store = new ActivityStore({
      fetch: async () => ({ errors: [], background: [bg({})] }),
      send: () => false,
      timers,
    })
    store.configure(config())
    await settle()
    expect(store.stopTask('t')).toBe(false)
    expect(store.getSnapshot().stopping).toEqual({})
    expect(store.getSnapshot().stopError).toContain('Connection lost')
  })
  test('The send function passed by the page takes priority over the default', async () => {
    const h = await ready()
    const own: ClientMessage[] = []
    h.store.setSender((message) => (own.push(message), true))
    h.store.stopTask('c1')
    expect(own).toHaveLength(1)
    expect(h.sent).toHaveLength(0)
  })
  test('Computer never replies: clear stopping and warn after timeout; no warning if the task ends as expected', async () => {
    const h = await ready()
    h.store.stopTask('c1')
    await h.timers.advance(STOP_TIMEOUT_MS)
    expect(h.store.getSnapshot().stopping).toEqual({})
    expect(h.store.getSnapshot().stopError).toContain('did not respond')

    const ok = await ready()
    ok.store.stopTask('c1')
    ok.set({ background: [agent({}), bg({ taskId: 'c1', status: 'stopped' })] })
    await ok.store.refresh()
    expect(ok.store.getSnapshot().stopping).toEqual({})
    await ok.timers.advance(STOP_TIMEOUT_MS)
    expect(ok.store.getSnapshot().stopError).toBe('')
  })
  test('Once all tasks stop, old stop-failure messages are cleared too', async () => {
    const h = await ready()
    h.store.stopTask('c1')
    await h.timers.advance(STOP_TIMEOUT_MS)
    h.set({ background: [agent({ status: 'stopped' }), bg({ taskId: 'c1', status: 'stopped' })] })
    await h.store.refresh()
    expect(h.store.getSnapshot().stopError).toBe('')
  })
})

describe('createActivityFetcher', () => {
  const fixture = (routes: Record<string, { status?: number; body: unknown }>) => {
    const paths: string[] = []
    const api = new ApiClient({ id: 'fixture', name: '', url: 'http://127.0.0.1:3457', auth: 'lan' }, 'fixture', {
      fetch: async (url) => {
        const path = new URL(url).pathname
        paths.push(path)
        const route = routes[path]
        const status = route ? (route.status ?? 200) : 404
        return { ok: status === 200, status, redirected: false, url, text: async () => JSON.stringify(route?.body ?? {}) }
      },
    })
    return { api, paths }
  }
  const routes = {
    '/api/tasks/lists/s%2F1': { body: { tasks: [info({ subject: 'x' })] } },
    '/api/sessions/s%2F1/background-tasks': { body: { tasks: [bg({})], historyComplete: true } },
  }
  test('One place reads three things: tasks, team (404 = no team), background tasks', async () => {
    const { api, paths } = fixture(routes)
    const result = await createActivityFetcher(api, 's/1')(new AbortController().signal, { team: true })
    expect(result.tasks).toHaveLength(1)
    expect(result.team).toBeNull()
    expect(result.background).toHaveLength(1)
    expect(result.errors).toEqual([])
    expect(paths).toHaveLength(3)
  })
  test('Do not send team requests when the team is not needed', async () => {
    const { api, paths } = fixture(routes)
    const result = await createActivityFetcher(api, 's/1')(new AbortController().signal, { team: false })
    expect(result.team).toBeUndefined()
    expect(paths.some((path) => path.includes('/teams/'))).toBe(false)
  })
  test('One part fails: the rest return as usual, and the failure reason goes into errors', async () => {
    const { api } = fixture({ ...routes, '/api/tasks/lists/s%2F1': { status: 500, body: { error: 'boom' } } })
    const result = await createActivityFetcher(api, 's/1')(new AbortController().signal, { team: false })
    expect(result.tasks).toBeUndefined()
    expect(result.background).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toStartWith('Tasks: ')
  })
})
