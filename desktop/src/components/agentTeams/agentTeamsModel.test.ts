import { describe, expect, it } from 'vitest'
import type { TeamMember, TeamWorkbenchSnapshot, TeamWorkbenchTask } from '../../types/team'
import {
  formatWorkbenchMessageTime,
  getWorkbenchPhase,
  getWorkbenchProgress,
  getWorkbenchTaskState,
  getMemberAvatarKey,
  inferTaskOwner,
  layoutWorkbenchTasks,
  parseWorkbenchMessageBody,
  resolveMemberModel,
  resolveTeamMemberIdentity,
  runningTaskForMember,
  shortModelLabel,
  snapshotWithHistoricalMembers,
  taskOwnedByMember,
  WORKBENCH_TASK_WIDTH,
} from './agentTeamsModel'

function task(
  id: string,
  status: TeamWorkbenchTask['status'],
  blockedBy: string[] = [],
  owner?: string,
): TeamWorkbenchTask {
  return {
    id,
    subject: `Task ${id}`,
    description: `Description ${id}`,
    status,
    owner,
    blocks: [],
    blockedBy,
    taskListId: 'team-a',
  }
}

function snapshot(tasks: TeamWorkbenchTask[]): TeamWorkbenchSnapshot {
  return {
    version: 'v1',
    generatedAt: '2026-08-08T00:00:00.000Z',
    team: {
      name: 'team-a',
      leadAgentId: 'lead@team-a',
      leadSessionId: 'session-a',
      members: [],
    },
    tasks,
    messages: [],
  }
}

describe('Agent Teams workbench model', () => {
  it('lays out dependency depth as horizontal lanes and keeps edge states honest', () => {
    const tasks = [
      task('1', 'completed'),
      task('2', 'in_progress'),
      task('3', 'pending', ['1', '2']),
      task('4', 'pending', ['missing']),
    ]
    const layout = layoutWorkbenchTasks(tasks, 604)
    const byId = new Map(tasks.map((entry) => [entry.id, entry]))

    expect(layout.columns).toBe(2)
    expect(layout.tasks.every((entry) => entry.x >= 0 && entry.x + WORKBENCH_TASK_WIDTH <= layout.width)).toBe(true)
    expect(layout.byId.get('3')!.x).toBeGreaterThan(layout.byId.get('1')!.x)
    expect(layout.byId.get('3')!.x).toBeGreaterThan(layout.byId.get('2')!.x)
    expect(layout.byId.get('1')!.row).toBe(0)
    expect(layout.byId.get('2')!.row).toBe(1)
    expect(layout.byId.get('4')!.row).toBe(2)
    expect(layout.byId.get('3')!.row).toBe(0)
    expect(layout.height).toBe(824)
    expect(layout.lanes).toEqual([
      { depth: 0, x: 76, y: 410, width: 216, height: 368, count: 3 },
      { depth: 1, x: 312, y: 410, width: 216, height: 368, count: 1 },
    ])
    expect(layout.legendY).toBe(790)
    expect(getWorkbenchTaskState(tasks[2]!, byId)).toBe('blocked')
    // A blocker that is no longer in the task list was deleted. `claimTask`
    // only counts blockers it can still find and that are not completed
    // (src/utils/tasks.ts), so this task is claimable rather than stranded --
    // and `layoutWorkbenchTasks` already ignores dependencies outside the list.
    expect(getWorkbenchTaskState(tasks[3]!, byId)).toBe('open')

    tasks[1] = task('2', 'completed')
    const completedParents = new Map(tasks.map((entry) => [entry.id, entry]))
    expect(getWorkbenchTaskState(tasks[2]!, completedParents)).toBe('open')
  })

  it('keeps a task blocked while a dependency it can still see is unfinished', () => {
    const tasks = [task('1', 'in_progress'), task('2', 'pending', ['1'])]
    const byId = new Map(tasks.map((entry) => [entry.id, entry]))

    expect(getWorkbenchTaskState(tasks[1]!, byId)).toBe('blocked')
  })

  it('recovers an ownerless task attribution from its assignment envelope', () => {
    const orphan = task('7', 'completed')
    const base = snapshot([task('2', 'completed', [], 'backend-dev'), orphan])
    const withAssignment: TeamWorkbenchSnapshot = {
      ...base,
      messages: [{
        id: 'mailbox-1',
        from: 'backend-dev',
        to: 'backend-dev',
        recipients: ['backend-dev'],
        kind: 'system',
        protocolType: 'task_assignment',
        taskId: '7',
        text: '{"type":"task_assignment","taskId":"7"}',
        timestamp: '2026-08-08T00:00:01.000Z',
      }],
    }

    expect(inferTaskOwner(orphan, withAssignment)).toEqual({
      identity: 'backend-dev',
      inferred: true,
    })
    // A recorded owner is fact and must never be relabelled as a guess.
    expect(inferTaskOwner(withAssignment.tasks[0]!, withAssignment)).toEqual({
      identity: 'backend-dev',
      inferred: false,
    })
    // Nothing to recover from leaves the task unattributed rather than guessing.
    expect(inferTaskOwner(orphan, base)).toBeUndefined()
  })

  it('uses the latest assignment when an ownerless task was reassigned', () => {
    const orphan = task('7', 'completed')
    const withReassignment: TeamWorkbenchSnapshot = {
      ...snapshot([orphan]),
      messages: [
        {
          id: 'mailbox-first-owner',
          from: 'team-lead',
          to: 'backend-dev',
          recipients: ['backend-dev'],
          kind: 'system',
          protocolType: 'task_assignment',
          taskId: '7',
          text: 'Build the API',
          timestamp: '2026-08-08T00:00:01.000Z',
        },
        {
          id: 'mailbox-final-owner',
          from: 'team-lead',
          to: 'reviewer',
          recipients: ['reviewer'],
          kind: 'system',
          protocolType: 'task_assignment',
          taskId: '7',
          text: 'Build the API',
          timestamp: '2026-08-08T00:00:02.000Z',
        },
      ],
    }

    expect(inferTaskOwner(orphan, withReassignment)).toEqual({
      identity: 'reviewer',
      inferred: true,
    })
  })

  it('falls back deterministically for cyclic dependencies instead of recursing forever', () => {
    const tasks = [
      task('a', 'pending', ['b']),
      task('b', 'pending', ['a']),
    ]

    const layout = layoutWorkbenchTasks(tasks, 440)
    const reversed = layoutWorkbenchTasks([...tasks].reverse(), 440)

    expect(layout.tasks.map((entry) => entry.task.id).sort()).toEqual(['a', 'b'])
    expect(layout.columns).toBeGreaterThan(0)
    expect(layout.tasks.map(({ task: entry, depth, row, x }) => ({
      id: entry.id,
      depth,
      row,
      x,
    }))).toEqual(reversed.tasks.map(({ task: entry, depth, row, x }) => ({
      id: entry.id,
      depth,
      row,
      x,
    })))
    expect(layout.tasks.every((entry) => entry.x >= 0 && entry.x + WORKBENCH_TASK_WIDTH <= layout.width)).toBe(true)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('uses the six prototype lanes at their natural 1460px width', () => {
    const tasks = [
      task('1', 'completed'),
      task('2', 'completed', ['1']),
      task('3', 'completed', ['2']),
      task('4', 'completed', ['3']),
      task('5', 'completed', ['4']),
      task('6', 'pending', ['5']),
    ]

    const layout = layoutWorkbenchTasks(tasks, 604)

    expect(layout.columns).toBe(6)
    expect(layout.width).toBe(1460)
    expect(layout.lanes.map(({ depth, x, count }) => ({ depth, x, count }))).toEqual([
      { depth: 0, x: 32, count: 1 },
      { depth: 1, x: 268, count: 1 },
      { depth: 2, x: 504, count: 1 },
      { depth: 3, x: 740, count: 1 },
      { depth: 4, x: 976, count: 1 },
      { depth: 5, x: 1212, count: 1 },
    ])
    expect(layout.tasks.map(({ depth, row, x, y }) => ({ depth, row, x, y }))).toEqual([
      { depth: 0, row: 0, x: 40, y: 442 },
      { depth: 1, row: 0, x: 276, y: 442 },
      { depth: 2, row: 0, x: 512, y: 442 },
      { depth: 3, row: 0, x: 748, y: 442 },
      { depth: 4, row: 0, x: 984, y: 442 },
      { depth: 5, row: 0, x: 1220, y: 442 },
    ])
  })

  it('stacks same-depth tasks naturally and centers lanes inside a requested minimum width', () => {
    const tasks = [
      task('task-10', 'pending'),
      task('task-2', 'pending'),
      task('task-1', 'pending'),
      task('next', 'pending', ['task-1']),
    ]

    const layout = layoutWorkbenchTasks(tasks, 800)

    expect(layout.width).toBe(800)
    expect(layout.lanes.map(({ x }) => x)).toEqual([174, 410])
    expect(layout.tasks.map(({ task: entry, depth, row, x, y }) => ({
      id: entry.id,
      depth,
      row,
      x,
      y,
    }))).toEqual([
      { id: 'task-1', depth: 0, row: 0, x: 182, y: 442 },
      { id: 'task-2', depth: 0, row: 1, x: 182, y: 548 },
      { id: 'task-10', depth: 0, row: 2, x: 182, y: 654 },
      { id: 'next', depth: 1, row: 0, x: 418, y: 442 },
    ])
    expect(layout.height).toBe(824)
  })

  it('normalizes bare owner names and full agent ids for active work', () => {
    const member: TeamMember = {
      agentId: 'reviewer@team-a',
      name: 'reviewer',
      role: 'security-reviewer',
      status: 'running',
    }
    const bareOwner = task('1', 'in_progress', [], 'reviewer')
    const fullOwner = task('2', 'pending', [], 'reviewer@team-a')

    expect(taskOwnedByMember(bareOwner, member)).toBe(true)
    expect(taskOwnedByMember(fullOwner, member)).toBe(true)
    expect(runningTaskForMember([fullOwner, bareOwner], member)?.id).toBe('1')
  })

  it('does not treat a shared role label as a member ownership identity', () => {
    const first: TeamMember = {
      agentId: 'reviewer-a@team-a',
      name: 'reviewer-a',
      role: 'security-reviewer',
      status: 'running',
    }
    const second: TeamMember = {
      agentId: 'reviewer-b@team-a',
      name: 'reviewer-b',
      role: 'security-reviewer',
      status: 'running',
    }
    const ambiguous = task('role-owned', 'in_progress', [], 'security-reviewer')

    expect(taskOwnedByMember(ambiguous, first)).toBe(false)
    expect(taskOwnedByMember(ambiguous, second)).toBe(false)
  })

  it('assigns generated occupational characters and preserves unknown-member identity', () => {
    const member = (agentId: string, role: string): TeamMember => ({
      agentId,
      name: agentId.split('@')[0],
      role,
      status: 'running',
    })

    expect(getMemberAvatarKey(member('lead@team-a', 'orchestrator'), true)).toBe('team-lead')
    expect(getMemberAvatarKey(member('watcher-runtime@team-a', 'backend'))).toBe('server-engineer')
    expect(getMemberAvatarKey(member('desktop-workbench@team-a', 'frontend'))).toBe('ui-designer')
    expect(getMemberAvatarKey(member('test-engineer@team-a', 'quality'))).toBe('qa-engineer')
    expect(getMemberAvatarKey(member('security-reviewer@team-a', 'reviewer'))).toBe('security-reviewer')
    expect(getMemberAvatarKey(member('release-auditor@team-a', 'release'))).toBe('release-engineer')
    expect(getMemberAvatarKey(member('unknown-specialist@team-a', 'general-purpose')))
      .toBe(getMemberAvatarKey(member('unknown-specialist@team-a', 'general-purpose')))
  })

  it('resolves bare transcript senders to the same full teammate identity as the workbench', () => {
    const team = {
      name: 'team-a',
      leadAgentId: 'team-lead@team-a',
      members: [
        { agentId: 'team-lead@team-a', name: 'team-lead', role: 'orchestrator', status: 'running' as const },
        { agentId: 'server-reviewer@team-a', name: 'server-reviewer', role: 'server engineer', status: 'idle' as const },
      ],
    }

    const lead = resolveTeamMemberIdentity(team, 'team-lead')
    const reviewer = resolveTeamMemberIdentity(team, 'server-reviewer@team-a')

    expect(lead.member.agentId).toBe('team-lead@team-a')
    expect(lead.isLead).toBe(true)
    expect(getMemberAvatarKey(lead.member, lead.isLead)).toBe('team-lead')
    expect(reviewer.member.agentId).toBe('server-reviewer@team-a')
    expect(getMemberAvatarKey(reviewer.member, reviewer.isLead)).toBe('security-reviewer')
  })

  it('replays roster transitions so shutdown cannot orphan a completed task owner', () => {
    const lead: TeamMember = {
      agentId: 'team-lead@team-a',
      name: 'team-lead',
      role: 'orchestrator',
      status: 'running',
    }
    const owner: TeamMember = {
      agentId: 'builder@team-a',
      name: 'builder',
      role: 'frontend',
      status: 'running',
    }
    const observer: TeamMember = {
      agentId: 'observer@team-a',
      name: 'observer',
      role: 'reviewer',
      status: 'idle',
    }
    const beforeRemoval = {
      ...snapshot([task('1', 'in_progress', [], 'builder')]),
      version: 'roster-1',
      team: { ...snapshot([]).team, members: [lead, owner, observer] },
    }
    const afterRemoval = {
      ...snapshot([task('1', 'completed', [], 'builder')]),
      version: 'roster-2',
      deletedAt: '2026-08-08T00:01:00.000Z',
      team: {
        ...snapshot([]).team,
        members: [
          { ...lead, status: 'completed' as const },
          { ...observer, status: 'completed' as const },
        ],
      },
    }

    const repaired = snapshotWithHistoricalMembers([beforeRemoval, afterRemoval], 1)!
    const repairedOwner = repaired.team.members.find(member => taskOwnedByMember(repaired.tasks[0]!, member))

    expect(repaired.team.members.map(member => ({
      name: member.name,
      status: member.status,
    }))).toEqual([
      { name: 'team-lead', status: 'completed' },
      { name: 'builder', status: 'completed' },
      { name: 'observer', status: 'completed' },
    ])
    expect(repairedOwner?.agentId).toBe('builder@team-a')
  })

  it('derives forming, running, finishing, and completed phases from real transitions', () => {
    expect(getWorkbenchPhase(snapshot([]))).toBe('forming')
    expect(getWorkbenchPhase(snapshot([task('1', 'in_progress')]))).toBe('running')

    const finished = snapshot([task('1', 'completed'), task('2', 'completed')])
    expect(getWorkbenchPhase(finished)).toBe('finishing')
    expect(getWorkbenchProgress(finished)).toEqual({ completed: 2, total: 2, percent: 100 })

    expect(getWorkbenchPhase({
      ...finished,
      deletedAt: '2026-08-08T00:01:00.000Z',
    })).toBe('completed')
  })

  it('narrates protocol payloads instead of leaking their raw JSON into the feed', () => {
    // This exact shape was rendering verbatim in the communication feed.
    const idle = parseWorkbenchMessageBody({
      text: '{"type":"idle_notification","from":"release-engineer","timestamp":"2026-08-08T07:42:16.666Z","idleReason":"available"}',
    })
    expect(idle).toEqual({ kind: 'lifecycle', type: 'idle_notification', detail: 'available' })

    // protocolType wins over the body, and is enough on its own.
    expect(parseWorkbenchMessageBody({ text: 'shutting down', protocolType: 'shutdown_request' }))
      .toEqual({ kind: 'lifecycle', type: 'shutdown_request', detail: undefined })

    // `TeamService.toWorkbenchMessage` replaces the assignment JSON body with
    // its subject while retaining the protocol metadata and routing fields.
    expect(parseWorkbenchMessageBody({
      text: 'Repair queue',
      protocolType: 'task_assignment',
      from: 'team-lead',
      recipients: ['builder'],
    })).toEqual({
      kind: 'assignment',
      selfClaim: false,
      subject: 'Repair queue',
    })
    expect(parseWorkbenchMessageBody({
      text: '{"type":"task_assignment","taskId":"7"}',
      protocolType: 'task_assignment',
      from: 'team-lead',
      recipients: ['builder'],
    })).toEqual({
      kind: 'assignment',
      selfClaim: false,
      taskId: '7',
    })

    // Authored prose is never reclassified.
    expect(parseWorkbenchMessageBody({ text: 'Race condition confirmed in queue.ts' }))
      .toEqual({ kind: 'text', text: 'Race condition confirmed in queue.ts' })
  })

  it('surfaces readable fields from unrecognised JSON rather than printing braces', () => {
    expect(parseWorkbenchMessageBody({ text: '{"type":"custom_event","message":"handoff ready"}' }))
      .toEqual({ kind: 'text', text: 'handoff ready' })

    // Nothing prose-like inside: keep the payload rather than silently dropping it.
    const opaque = '{"type":"custom_event","count":3}'
    expect(parseWorkbenchMessageBody({ text: opaque })).toEqual({ kind: 'text', text: opaque })

    // Malformed JSON must not throw or be mistaken for a protocol signal.
    expect(parseWorkbenchMessageBody({ text: '{not json' })).toEqual({ kind: 'text', text: '{not json' })
  })

  it('stamps messages with their own send time, not a shared snapshot index', () => {
    const first = formatWorkbenchMessageTime('2026-08-08T07:42:16.666Z')
    const second = formatWorkbenchMessageTime('2026-08-08T09:15:00.000Z')
    expect(first).toBeTruthy()
    // Two messages inside one snapshot used to render an identical `T+0`.
    expect(first).not.toBe(second)
    expect(formatWorkbenchMessageTime('not-a-date')).toBe('')
  })
})

describe('Agent Teams member model display', () => {
  const worker: TeamMember = {
    agentId: 'builder@team-a',
    name: 'builder',
    role: 'Frontend',
    status: 'running',
  }

  function memberSnapshot(generatedAt: string, members: TeamMember[]): TeamWorkbenchSnapshot {
    return {
      version: generatedAt,
      generatedAt,
      team: {
        name: 'team-a',
        leadAgentId: 'lead@team-a',
        leadSessionId: 'session-a',
        members,
      },
      tasks: [],
      messages: [],
    }
  }

  it('shortens a full model id to its family and passes unknown ids through', () => {
    expect(shortModelLabel('claude-opus-4-8')).toBe('opus')
    expect(shortModelLabel('eu.anthropic.claude-sonnet-5')).toBe('sonnet')
    expect(shortModelLabel('claude-haiku-4-5')).toBe('haiku')
    expect(shortModelLabel('claude-fable-5')).toBe('fable')
    expect(shortModelLabel('sonnet')).toBe('sonnet')
    // An unknown family is preserved rather than forced into a known one.
    expect(shortModelLabel('gpt-5')).toBe('gpt-5')
  })

  it('keeps the full id for the tooltip while the chip shows the short family', () => {
    expect(resolveMemberModel({ ...worker, model: 'claude-opus-4-8' }))
      .toEqual({ label: 'opus', full: 'claude-opus-4-8', inherited: false })
  })

  it('trims the stored id so no padding leaks into the label or the tooltip', () => {
    expect(resolveMemberModel({ ...worker, model: '  claude-opus-4-8  ' }))
      .toEqual({ label: 'opus', full: 'claude-opus-4-8', inherited: false })
  })

  it('drops the context-window tag from the chip while the tooltip keeps it', () => {
    // `[1m]` is a routing detail, and leaving it on made the chip wide enough to
    // squeeze the member name out of the card.
    expect(shortModelLabel('qwen3.7-plus[1m]')).toBe('qwen3.7-plus')
    expect(shortModelLabel('claude-opus-4-8[1m]')).toBe('opus')
    expect(resolveMemberModel({ ...worker, model: 'qwen3.7-plus[1m]' }))
      .toEqual({ label: 'qwen3.7-plus', full: 'qwen3.7-plus[1m]', inherited: false })
    // A value that is nothing but a tag must not collapse to an empty label.
    expect(shortModelLabel('[1m]')).toBe('[1m]')
  })

  it('marks a member with no model of its own as inheriting the lead model', () => {
    expect(resolveMemberModel({ ...worker }, 'claude-sonnet-5'))
      .toEqual({ label: 'sonnet', full: 'claude-sonnet-5', inherited: true })
  })

  it('treats an explicit inherit alias as inheritance, not as a model name', () => {
    expect(resolveMemberModel({ ...worker, model: 'inherit' }, 'claude-opus-4-8'))
      .toEqual({ label: 'opus', full: 'claude-opus-4-8', inherited: true })
    expect(resolveMemberModel({ ...worker, model: 'INHERIT' }, 'claude-opus-4-8'))
      .toEqual({ label: 'opus', full: 'claude-opus-4-8', inherited: true })
  })

  it('returns undefined when nothing is known, so callers render no empty label', () => {
    expect(resolveMemberModel({ ...worker })).toBeUndefined()
    expect(resolveMemberModel({ ...worker, model: '' })).toBeUndefined()
    expect(resolveMemberModel({ ...worker, model: '   ' })).toBeUndefined()
    expect(resolveMemberModel({ ...worker, model: 'inherit' })).toBeUndefined()
    // A blank lead model must not be promoted into an inherited label either.
    expect(resolveMemberModel({ ...worker }, '   ')).toBeUndefined()
  })

  it('keeps a model learned from an earlier frame when a later frame omits it', () => {
    const earlier = memberSnapshot('2026-08-08T07:00:00.000Z', [
      { ...worker, model: 'claude-opus-4-8' },
    ])
    const later = memberSnapshot('2026-08-08T07:05:00.000Z', [{ ...worker }])

    const merged = snapshotWithHistoricalMembers([earlier, later], 1)

    expect(merged?.team.members[0]?.model).toBe('claude-opus-4-8')
  })

  it('lets a later frame update the model when it actually carries one', () => {
    const earlier = memberSnapshot('2026-08-08T07:00:00.000Z', [
      { ...worker, model: 'claude-opus-4-8' },
    ])
    const later = memberSnapshot('2026-08-08T07:05:00.000Z', [
      { ...worker, model: 'claude-haiku-4-5' },
    ])

    const merged = snapshotWithHistoricalMembers([earlier, later], 1)

    expect(merged?.team.members[0]?.model).toBe('claude-haiku-4-5')
  })
})
